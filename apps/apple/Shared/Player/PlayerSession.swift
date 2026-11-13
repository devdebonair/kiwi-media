import AVFoundation
import Foundation
import UIKit

/// Prepares and runs playback for one `PlayRequest`.
///
/// - **Assets** resume where the viewer left off, save progress the way the web player does (every few seconds
///   while playing, on pause, on finish and when closed), and move on to the next episode at the end.
/// - **Channels** join live: whatever the guide says is airing now, from the current point in the program,
///   re-tuning when it ends. Progress isn't saved for live viewing. Channel up/down surfs the lineup.
///
/// Both modes keep the viewer's like level for whatever is on screen.
@Observable
final class PlayerSession {
    enum Phase: Equatable {
        case preparing(String)
        case playing
        case failed(String)
    }

    private(set) var phase: Phase = .preparing("Loading…")
    private(set) var player: AVPlayer?
    private(set) var heading = ""
    /// The asset on screen, for likes.
    private(set) var assetId: String?
    private(set) var myLikes = 0
    /// "103 Comedy" while watching a channel.
    private(set) var channelLabel: String?

    var isLive: Bool {
        if case .channel = source { return true }
        return false
    }

    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private var source: PlayRequest.Source
    /// Movie time at stream time 0. Zero for direct play; the server's keyframe-snapped start for HLS.
    @ObservationIgnored private var origin: Double = 0
    /// Progress is only saved once the resume seek is done, so an early save of 0 can't wipe it.
    @ObservationIgnored private var canSave = false
    @ObservationIgnored private var nextAssetId: String?
    /// The asset's full length in seconds, to tell a real ending from a stream that stopped short. Nil for channels.
    @ObservationIgnored private var runtime: Double?
    /// Where to pick up after an interrupted stream, instead of the saved progress (whose save may not have landed).
    @ObservationIgnored private var resumeAt: Double?
    /// How many times this asset's stream has been restarted after stopping short.
    @ObservationIgnored private var restarts = 0
    @ObservationIgnored private var channelKeys: [String] = []
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    @ObservationIgnored private var endObserver: (any NSObjectProtocol)?
    @ObservationIgnored private var failObserver: (any NSObjectProtocol)?
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var isLiking = false

    init(api: APIClient, request: PlayRequest) {
        self.api = api
        self.source = request.source
    }

    func start() {
        loadTask?.cancel()
        loadTask = Task { await load() }
    }

    /// Saves where the viewer stopped and releases the player.
    func stop() {
        loadTask?.cancel()
        saveProgress(completed: false)
        tearDown()
    }

    // MARK: Likes

    /// Adds one like, up to five, like the web's like button. Optimistic; reverts if the server refuses.
    func like() async {
        guard let assetId, !isLiking, myLikes < LikeLevel.maximum else { return }
        await setLikes(myLikes + 1, on: assetId)
    }

    func clearLikes() async {
        guard let assetId, !isLiking else { return }
        await setLikes(0, on: assetId)
    }

    private func setLikes(_ level: Int, on id: String) async {
        isLiking = true
        defer { isLiking = false }
        let previous = myLikes
        myLikes = level
        do {
            let result = try await api.setLikes(id, count: level)
            if assetId == id { myLikes = result.myLikes ?? level }
        } catch {
            if assetId == id { myLikes = previous }
        }
    }

    // MARK: Channels

    /// Moves `step` channels up or down the lineup and tunes in.
    func changeChannel(by step: Int) {
        guard case let .channel(key) = source else { return }
        Task {
            if channelKeys.isEmpty {
                channelKeys = ((try? await api.guide(hours: 1, limit: 100))?.channels ?? []).map(\.key)
            }
            guard !channelKeys.isEmpty else { return }
            let index = channelKeys.firstIndex(of: key) ?? 0
            let next = channelKeys[(index + step + channelKeys.count) % channelKeys.count]
            saveProgress(completed: false)
            source = .channel(next)
            start()
        }
    }

    // MARK: Loading

    private func load() async {
        tearDown()
        phase = .preparing("Loading…")
        do {
            switch source {
            case let .asset(id, startOver): try await playAsset(id, startOver: startOver)
            case let .channel(key): try await tuneIn(key)
            }
        } catch is CancellationError {
            return
        } catch {
            tearDown()
            phase = .failed(error.localizedDescription)
        }
    }

    private func playAsset(_ id: String, startOver: Bool) async throws {
        let detail = try await api.asset(id)
        if assetId != id { restarts = 0 }
        assetId = id
        myLikes = detail.myLikes
        heading = Self.heading(for: detail)
        nextAssetId = detail.catalog?.next?.id
        runtime = detail.durationMs.flatMap { $0 > 0 ? Double($0) / 1000 : nil }
        let resume = resumeAt
        resumeAt = nil
        try await startPlayback(id, at: { resume ?? Self.resumePoint(detail, startOver: startOver) }, metadata: Self.metadata(detail), savesProgress: true)
    }

    /// Joins whatever the channel is airing now, from the current point in the program (the web guide's rule:
    /// within 15 seconds of the start, begin at the start).
    private func tuneIn(_ key: String) async throws {
        phase = .preparing("Tuning in…")
        let guide = try await api.guide(hours: 3, limit: 1, channel: key)
        guard let channel = guide.channels.first,
              let program = channel.airing(at: GuideClock.now) ?? channel.programs.first
        else { throw APIError.http(status: 404, message: "Nothing is on this channel right now.", code: nil) }
        Task { try? await api.tune(key) }

        channelLabel = "\(channel.number) \(channel.name)"
        heading = [channelLabel, program.title].compactMap { $0 }.joined(separator: " · ")
        assetId = program.assetId
        nextAssetId = nil
        runtime = nil
        let detail = try? await api.asset(program.assetId)
        myLikes = detail?.myLikes ?? 0
        let liveOffset = {
            let elapsed = max(0, (GuideClock.now - program.start) / 1000)
            return elapsed < 15 ? 0 : elapsed
        }
        var metadata = Self.metadata(title: program.title, subtitle: [channelLabel, program.subtitle].compactMap { $0 }.joined(separator: " · "), description: detail?.description)
        if metadata.isEmpty, let detail { metadata = Self.metadata(detail) }
        try await startPlayback(program.assetId, at: liveOffset, metadata: metadata, savesProgress: false)
    }

    /// Gets a stream for `id` and starts it at `start()` seconds into the video. `start` is evaluated when it's
    /// needed, so a live position accounts for the time spent getting the stream ready.
    private func startPlayback(_ id: String, at start: () -> Double, metadata: [AVMetadataItem], savesProgress: Bool) async throws {
        let info = try await prepareStream(id)
        let plan = PlaybackPlanner.plan(info: info, assetId: id, startSeconds: start())

        if plan.kind == .hls {
            phase = .preparing(isLive ? "Tuning in…" : "Starting stream…")
            let streamStart = try? await api.streamStart(id, start: plan.start, video: plan.video)
            origin = streamStart?.origin ?? Double(plan.start)
        } else {
            origin = 0
        }
        try Task.checkCancellation()

        guard let url = api.url(plan.path) else { throw APIError.noServer }
        let asset = AVURLAsset(url: url, options: [AVURLAssetHTTPCookiesKey: api.cookies()])
        let item = AVPlayerItem(asset: asset)
        item.externalMetadata = metadata
        let player = AVPlayer(playerItem: item)
        self.player = player
        phase = .playing

        try await waitUntilReady(item)
        if plan.kind == .direct {
            let seconds = start()
            if seconds > 0 { await player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600)) }
        }
        try Task.checkCancellation()
        player.play()
        canSave = savesProgress
        observe(player, item)
        let viewSession = UUID().uuidString
        Task { try? await api.recordView(id, sessionId: viewSession) }
    }

    /// `POST /stream` answers 202 while the server finds a source or probes the file; ask again until ready.
    private func prepareStream(_ id: String) async throws -> StreamInfo {
        for _ in 0..<180 {
            let (info, status) = try await api.prepareStream(id)
            if status != 202 || info.status == "ready" { return info }
            phase = .preparing(info.stage ?? "Getting this ready…")
            try await Task.sleep(for: .seconds(1))
        }
        throw APIError.http(status: 504, message: "This took too long to get ready. Try again in a moment.", code: nil)
    }

    /// Waits for the item to load, up to a minute. Polling keeps this simple and on the main actor.
    private func waitUntilReady(_ item: AVPlayerItem) async throws {
        for _ in 0..<600 {
            switch item.status {
            case .readyToPlay: return
            case .failed: throw item.error ?? APIError.http(status: 0, message: "This video can't be played.", code: nil)
            default: try await Task.sleep(for: .milliseconds(100))
            }
        }
        throw APIError.http(status: 0, message: "The video took too long to start.", code: nil)
    }

    // MARK: Progress

    private func observe(_ player: AVPlayer, _ item: AVPlayerItem) {
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 5, preferredTimescale: 1), queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, let player = self.player, player.rate > 0 else { return }
                self.saveProgress(completed: false)
            }
        }
        observations.append(player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            let paused = player.timeControlStatus == .paused
            Task { @MainActor in
                if paused { self?.saveProgress(completed: false) }
            }
        })
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.finished() }
        }
        failObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) { [weak self] note in
            let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            Task { @MainActor in self?.stoppedShort(error) }
        }
    }

    private func saveProgress(completed: Bool) {
        guard canSave, let player, let id = assetId else { return }
        let position = origin + player.currentTime().seconds
        guard position.isFinite, position >= 0 else { return }
        let ms = Int(position * 1000)
        Task { try? await api.saveProgress(id, progressMs: ms, completed: completed) }
    }

    private func finished() {
        if resumeInterruptedStream() { return }
        saveProgress(completed: true)
        canSave = false
        if isLive {
            // The next program is on now; tune to it.
            start()
            return
        }
        guard let next = nextAssetId else { return }
        source = .asset(next, startOver: false)
        start()
    }

    /// The stream broke off before the end (a network or server error).
    private func stoppedShort(_ error: Error?) {
        if resumeInterruptedStream() { return }
        saveProgress(completed: false)
        tearDown()
        phase = .failed(error?.localizedDescription ?? "Playback stopped unexpectedly.")
    }

    /// A repackaged stream can end well before the episode does: the server's encode broke off, or its stream was
    /// cleared during a long pause. That is an interruption, not the end, so instead of moving on to the next
    /// episode, pick up where it stopped (twice at most, so a file that is really shorter can't loop).
    private func resumeInterruptedStream() -> Bool {
        guard case let .asset(id, _) = source, let runtime, let player, restarts < 2 else { return false }
        let position = origin + player.currentTime().seconds
        guard position.isFinite, position >= 0, position < runtime - 60 else { return false }
        restarts += 1
        saveProgress(completed: false)
        resumeAt = position
        source = .asset(id, startOver: false)
        start()
        return true
    }

    private func tearDown() {
        canSave = false
        if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        observations.forEach { $0.invalidate() }
        observations = []
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        if let failObserver { NotificationCenter.default.removeObserver(failObserver) }
        failObserver = nil
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        player = nil
    }

    // MARK: Helpers

    static func resumePoint(_ detail: Asset, startOver: Bool) -> Double {
        guard !startOver, !detail.completed, let progress = detail.progressMs else { return 0 }
        let seconds = Double(progress) / 1000
        if seconds < 5 { return 0 }
        if let duration = detail.durationMs, seconds > Double(duration) / 1000 - 15 { return 0 }
        return seconds
    }

    static func heading(for detail: Asset) -> String {
        guard let catalog = detail.catalog, let show = catalog.title else { return detail.displayTitle }
        if catalog.type == "show", let season = catalog.season, let episode = catalog.episode {
            return "\(show) · S\(season):E\(episode) \(detail.title ?? "")".trimmingCharacters(in: .whitespaces)
        }
        return show
    }

    private static func metadata(_ detail: Asset) -> [AVMetadataItem] {
        if let catalog = detail.catalog, catalog.type == "show" {
            let subtitle = catalog.season.flatMap { season in catalog.episode.map { "\(catalog.title ?? "") · Season \(season), Episode \($0)" } }
            return metadata(title: detail.title ?? catalog.title, subtitle: subtitle, description: detail.description)
        }
        return metadata(title: detail.catalog?.title ?? detail.displayTitle, subtitle: nil, description: detail.description)
    }

    private static func metadata(title: String?, subtitle: String?, description: String?) -> [AVMetadataItem] {
        var items: [AVMetadataItem] = []
        func add(_ identifier: AVMetadataIdentifier, _ value: String?) {
            guard let value, !value.isEmpty else { return }
            let item = AVMutableMetadataItem()
            item.identifier = identifier
            item.value = value as NSString
            item.extendedLanguageTag = "und"
            items.append(item)
        }
        add(.commonIdentifierTitle, title)
        add(.iTunesMetadataTrackSubTitle, subtitle)
        add(.commonIdentifierDescription, description)
        return items
    }
}
