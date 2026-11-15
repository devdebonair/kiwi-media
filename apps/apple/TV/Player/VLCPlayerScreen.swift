import SwiftUI
import UIKit
import VLCKit

/// Movies, episodes and videos play the original file with VLCKit, as on iPhone, so the player knows the real
/// length and every audio and subtitle track. Live channels use the system player (`LivePlayerScreen`); these
/// controls copy its look and its remote, so both feel like the same player:
///
/// - Click pauses (showing the controls) and plays again; Play/Pause does the same.
/// - Left and right skip 10 seconds. While paused, swiping on the touch surface scrubs; click to jump there,
///   Back to stay put.
/// - Up reaches the buttons (Next Episode, Like, Subtitles, Audio).
/// - Back hides the controls while playing, and otherwise closes the player.
struct VLCPlayerScreen: View {
    @State private var playback: VLCPlayback
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focus: Control?

    private enum Control: Hashable {
        case timeline, next, like, subtitles, audio
    }

    init(api: APIClient, assetId: String, startOver: Bool) {
        _playback = State(initialValue: VLCPlayback(api: api, assetId: assetId, startOver: startOver))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VLCVideoView(player: playback.player)
                .ignoresSafeArea()
                .opacity(playback.phase == .playing || playback.phase == .ended ? 1 : 0)

            switch playback.phase {
            case let .loading(message):
                loading(message)
            case let .failed(message):
                failure(message)
            case .playing, .ended:
                controls
            }
            RemoteSwipeReader { phase in playback.swipe(phase) }
                .frame(width: 0, height: 0)
        }
        .onAppear { playback.start() }
        .onDisappear { playback.close() }
        .onExitCommand(perform: back)
        .onPlayPauseCommand { playback.togglePlay() }
        .onChange(of: playback.controlsVisible) { _, visible in
            // Hidden controls keep focus on the (invisible) timeline, so the remote still pauses and skips.
            if !visible { focus = .timeline }
        }
        .onChange(of: focus) { _, focus in
            playback.holdControls = focus != .timeline
            playback.poke()
        }
    }

    private func back() {
        if playback.isScrubbing {
            playback.cancelScrub()
        } else if focus != .timeline && playback.controlsVisible {
            focus = .timeline
        } else if playback.controlsVisible && playback.isPlaying {
            playback.hideControls()
        } else {
            dismiss()
        }
    }

    // MARK: Controls

    private var controls: some View {
        ZStack(alignment: .bottomLeading) {
            // A soft shade behind the text, like the system player's.
            LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .center, endPoint: .bottom)
                .ignoresSafeArea()
                .allowsHitTesting(false)
                .visualEffect { [visible = playback.controlsVisible] content, _ in content.opacity(visible ? 1 : 0) }

            transport
                // The system player's margins, measured from the screen edge rather than the safe area.
                .padding(.horizontal, 86)
                .padding(.bottom, 49)
            .ignoresSafeArea(edges: .horizontal)
            .visualEffect { [visible = playback.controlsVisible] content, _ in content.opacity(visible ? 1 : 0) }
        }
        .animation(.easeInOut(duration: 0.25), value: playback.controlsVisible)
        .foregroundStyle(.white)
        .defaultFocus($focus, .timeline)
    }

    /// Title and buttons, the timeline, and the times under it.
    private var transport: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .bottom, spacing: 30) {
                VStack(alignment: .leading, spacing: 4) {
                    if !playback.subtitle.isEmpty {
                        Text(playback.subtitle)
                            .font(.system(size: 25))
                            .foregroundStyle(.white.opacity(0.9))
                    }
                    Text(playback.title)
                        .font(.system(size: 56, weight: .bold))
                        .lineLimit(1)
                }
                .shadow(color: .black.opacity(0.35), radius: 10)
                Spacer(minLength: 40)
                buttons
            }
            timeline
                .padding(.top, 26)
        }
    }

    private var buttons: some View {
        HStack(spacing: 28) {
            if playback.hasNext {
                Button { playback.playNext() } label: { Image(systemName: "forward.end.fill") }
                    .buttonStyle(GlassCircleStyle())
                    .focused($focus, equals: .next)
            }
            Button {
                Task { await playback.like() }
            } label: {
                Image(systemName: playback.myLikes > 0 ? "heart.fill" : "heart")
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(GlassCircleStyle())
            .focused($focus, equals: .like)
            if !playback.textTracks.isEmpty {
                Menu {
                    Picker("Subtitles", selection: Binding(get: { playback.textTracks.first(where: \.selected)?.id ?? -1 }, set: { playback.selectText($0 < 0 ? nil : $0) })) {
                        Text("Off").tag(-1)
                        ForEach(playback.textTracks) { Text($0.name).tag($0.id) }
                    }
                    .pickerStyle(.inline)
                } label: {
                    Image(systemName: "captions.bubble")
                }
                .buttonStyle(GlassCircleStyle())
                .focused($focus, equals: .subtitles)
            }
            if playback.audioTracks.count > 1 {
                Menu {
                    Picker("Audio", selection: Binding(get: { playback.audioTracks.first(where: \.selected)?.id ?? 0 }, set: { playback.selectAudio($0) })) {
                        ForEach(playback.audioTracks) { Text($0.name).tag($0.id) }
                    }
                    .pickerStyle(.inline)
                } label: {
                    Image(systemName: "waveform")
                }
                .buttonStyle(GlassCircleStyle())
                .focused($focus, equals: .audio)
            }
        }
        .disabled(!playback.controlsVisible)
        .focusSection()
    }

    /// The bar is what has focus while watching: click pauses or plays, left and right skip, and a swipe while
    /// paused scrubs. It stays focusable while hidden (faded in drawing rather than with `.opacity`).
    private var timeline: some View {
        Button {
            if playback.isScrubbing { playback.commitScrub() } else { playback.togglePlay() }
        } label: {
            TimelineBar(
                time: playback.displayTime,
                length: playback.length,
                status: playback.statusSymbol
            )
        }
        .buttonStyle(TimelineButtonStyle())
        .focused($focus, equals: .timeline)
        .onMoveCommand { direction in
            switch direction {
            case .left: playback.skip(by: -10)
            case .right: playback.skip(by: 10)
            default: playback.showControls()
            }
        }
    }

    // MARK: Loading and errors

    private func loading(_ message: String) -> some View {
        VStack(spacing: 28) {
            ProgressView().controlSize(.large)
            if !playback.title.isEmpty {
                Text(playback.heading)
                    .font(.system(size: 30, weight: .semibold))
            }
            Text(message)
                .font(.system(size: 25))
                .foregroundStyle(Theme.secondaryText)
        }
    }

    private func failure(_ message: String) -> some View {
        VStack(spacing: 32) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 64))
                .foregroundStyle(.yellow)
            Text("Can't play this right now")
                .font(.title2.weight(.semibold))
            Text(message)
                .foregroundStyle(Theme.secondaryText)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 1000)
            HStack(spacing: 24) {
                Button("Try Again") { playback.start() }
                    .primaryAction()
                Button("Close") { dismiss() }
                    .secondaryAction()
            }
        }
    }
}

// MARK: - Pieces

/// The system player's timeline: a thin track that thickens with focus, the elapsed time riding under the
/// playhead, and the time remaining at the right.
private struct TimelineBar: View {
    let time: Double
    let length: Double
    /// Shown beside the elapsed time: paused, or the direction of a skip.
    let status: String?

    @Environment(\.isFocused) private var isFocused

    var body: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            let fraction = length > 0 ? min(max(time / length, 0), 1) : 0
            let x = width * fraction
            ZStack(alignment: .topLeading) {
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.32))
                    Capsule().fill(.white.opacity(0.9)).frame(width: max(x, isFocused ? 10 : 4))
                }
                .frame(height: isFocused ? 10 : 4)
                .frame(height: 20)
                Rectangle()
                    .fill(.white)
                    .frame(width: 2, height: 20)
                    .offset(x: x - 1)
                HStack(spacing: 10) {
                    Text(Self.format(time))
                    if let status {
                        Image(systemName: status)
                            .font(.system(size: 28, weight: .regular))
                            .contentTransition(.symbolEffect(.replace))
                    }
                }
                .fixedSize()
                .alignmentGuide(.leading) { d in
                    // Centered under the playhead, kept on screen.
                    let left = x - d.width / 2
                    return -min(max(0, left), width - d.width - 170)
                }
                .offset(y: 34)
                Text(Self.format(max(0, length - time), negative: true))
                    .frame(width: width, alignment: .trailing)
                    .offset(y: 34)
            }
            .font(.system(size: 24, weight: .semibold).monospacedDigit())
            .shadow(color: .black.opacity(0.3), radius: 6)
        }
        .frame(height: 72)
        .animation(.easeOut(duration: 0.15), value: isFocused)
    }

    static func format(_ seconds: Double, negative: Bool = false) -> String {
        let total = Int(seconds.rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        let text = h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
        return negative ? "-" + text : text
    }
}

private struct TimelineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
    }
}

/// The round glass buttons at the right of the system player; white when focused.
private struct GlassCircleStyle: ButtonStyle {
    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 26, weight: .semibold))
            .foregroundStyle(isFocused ? Color.black : Color.white)
            .frame(width: 66, height: 66)
            .background {
                if isFocused { Circle().fill(.white) }
            }
            .glassEffect(isFocused ? .identity : .regular, in: Circle())
            .scaleEffect(isFocused ? 1.15 : (configuration.isPressed ? 0.95 : 1))
            .shadow(color: .black.opacity(isFocused ? 0.3 : 0), radius: 10, y: 4)
            .animation(.easeOut(duration: 0.15), value: isFocused)
    }
}

/// The view VLCKit draws into.
private struct VLCVideoView: UIViewRepresentable {
    let player: VLCMediaPlayer

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .black
        view.isUserInteractionEnabled = false
        player.drawable = view
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {}
}

/// Swipes on the Siri Remote's touch surface, for scrubbing. The recognizer goes on the window, so it sees
/// touches whatever has focus; it never cancels them, so focus moves and button presses work as before.
/// A swipe on the touch surface: its start, its horizontal travel so far, its end.
enum RemoteSwipe {
    case began
    case changed(CGFloat)
    case ended
}

private struct RemoteSwipeReader: UIViewRepresentable {
    let onSwipe: (RemoteSwipe) -> Void

    func makeUIView(context: Context) -> SwipeView {
        let view = SwipeView()
        view.onSwipe = onSwipe
        return view
    }

    func updateUIView(_ view: SwipeView, context: Context) {
        view.onSwipe = onSwipe
    }

    static func dismantleUIView(_ view: SwipeView, coordinator: ()) {
        view.detach()
    }

    final class SwipeView: UIView {
        var onSwipe: (RemoteSwipe) -> Void = { _ in }
        private lazy var pan: UIPanGestureRecognizer = {
            let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
            pan.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirect.rawValue)]
            pan.cancelsTouchesInView = false
            return pan
        }()

        override func didMoveToWindow() {
            super.didMoveToWindow()
            pan.view?.removeGestureRecognizer(pan)
            window?.addGestureRecognizer(pan)
        }

        func detach() {
            pan.view?.removeGestureRecognizer(pan)
        }

        @objc private func panned(_ pan: UIPanGestureRecognizer) {
            switch pan.state {
            case .began: onSwipe(.began)
            case .changed: onSwipe(.changed(pan.translation(in: pan.view).x))
            case .ended, .cancelled, .failed: onSwipe(.ended)
            default: break
            }
        }
    }
}

// MARK: - Playback

/// Loads an asset into VLC and keeps its state for the controls, polled a few times a second. Saves progress
/// the way the web player does (every few seconds while playing, on pause, at the end and when closed) and moves
/// on to the next episode at the end.
@Observable
final class VLCPlayback {
    enum Phase: Equatable {
        case loading(String)
        case playing
        case ended
        case failed(String)
    }

    struct Track: Identifiable, Equatable {
        let id: Int
        let name: String
        let selected: Bool
    }

    private(set) var phase: Phase = .loading("Loading…")
    private(set) var title = ""
    private(set) var subtitle = ""
    private(set) var time: Double = 0
    private(set) var length: Double = 0
    private(set) var isPlaying = false
    private(set) var myLikes = 0
    private(set) var audioTracks: [Track] = []
    private(set) var textTracks: [Track] = []
    private(set) var controlsVisible = true
    /// "Chip 'n' Dale Rescue Rangers · S1:E1 · Piratsy Under the Seas", for the loading screen.
    private(set) var heading = ""
    /// +10 or -10 for a moment after a skip.
    private(set) var skipNotice: Int?
    /// Where a swipe has scrubbed to, before a click commits it.
    private(set) var scrubTime: Double?
    /// Keeps the controls up while focus is on a button rather than the timeline.
    @ObservationIgnored var holdControls = false {
        didSet { if !holdControls, controlsVisible { scheduleHide() } }
    }
    var hasNext: Bool { nextAssetId != nil }
    var isScrubbing: Bool { scrubTime != nil }
    var displayTime: Double { scrubTime ?? time }

    /// The symbol beside the elapsed time, as in the system player.
    var statusSymbol: String? {
        if let skipNotice { return skipNotice > 0 ? "goforward.10" : "gobackward.10" }
        if phase == .ended { return "arrow.counterclockwise.circle" }
        return isPlaying && scrubTime == nil ? nil : "pause.circle"
    }

    @ObservationIgnored let player: VLCMediaPlayer
    @ObservationIgnored private let library: VLCLibrary
    @ObservationIgnored private let api: APIClient
    @ObservationIgnored private var assetId: String
    @ObservationIgnored private var startOver: Bool
    @ObservationIgnored private var nextAssetId: String?
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var hideTask: Task<Void, Never>?
    @ObservationIgnored private var skipTask: Task<Void, Never>?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var lastSave = Date()
    @ObservationIgnored private var isLiking = false
    @ObservationIgnored private var closed = false
    /// Getting to the saved position: waiting until the file can seek, then until the seek lands.
    @ObservationIgnored private var resume: Resume?
    @ObservationIgnored private var scrubBase: Double?

    private enum Resume {
        case pending(Double)
        case seeking(Double, since: Date)
    }

    init(api: APIClient, assetId: String, startOver: Bool) {
        self.api = api
        self.assetId = assetId
        self.startOver = startOver
        let logger = VLCConsoleLogger()
        logger.level = .warning
        library = VLCLibrary()
        library.loggers = [logger]
        player = VLCMediaPlayer(library: library)
    }

    func start() {
        closed = false
        loadTask?.cancel()
        loadTask = Task { await load() }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    /// Saves where the viewer stopped and releases the player.
    func close() {
        guard !closed else { return }
        closed = true
        loadTask?.cancel()
        timer?.invalidate()
        timer = nil
        hideTask?.cancel()
        if phase == .playing { saveProgress(completed: false) }
        player.stop()
    }

    // MARK: Loading

    private func load() async {
        player.stop()
        phase = .loading("Loading…")
        time = 0
        length = 0
        do {
            let detail = try await api.asset(assetId)
            (title, subtitle) = Self.titles(for: detail)
            heading = subtitle.isEmpty ? title : "\(subtitle) · \(title)"
            scrubTime = nil
            myLikes = detail.myLikes
            nextAssetId = detail.catalog?.next?.id
            // Catalog titles need the server to find a source first, as with the system player.
            for _ in 0..<180 {
                let (info, code) = try await api.prepareStream(assetId)
                if code != 202 || info.status == "ready" { break }
                phase = .loading(info.stage ?? "Getting this ready…")
                try await Task.sleep(for: .seconds(1))
            }
            try Task.checkCancellation()
            guard let url = api.url("/api/v1/assets/\(APIClient.segment(assetId))/file"), let media = VLCMedia(url: url) else {
                throw APIError.noServer
            }
            if let host = url.host() {
                for cookie in api.cookies() { media.storeCookie("\(cookie.name)=\(cookie.value)", forHost: host, path: "/") }
            }
            // Open from the real beginning and seek once it's playing. VLC's `:start-time` option would make the
            // resume point the start of the timeline, so the bar would only cover what's left.
            let start = PlayerSession.resumePoint(detail, startOver: startOver)
            resume = start > 0 ? .pending(start) : nil
            phase = .loading("Starting…")
            player.media = media
            player.audio?.isMuted = resume != nil
            player.play()
            let id = assetId
            let viewSession = UUID().uuidString
            Task { [api] in try? await api.recordView(id, sessionId: viewSession) }
        } catch is CancellationError {
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Title and the line above it, as the system player shows them: the episode, under its show and number.
    private static func titles(for detail: Asset) -> (String, String) {
        if let catalog = detail.catalog, catalog.type == "show" {
            let show = catalog.title ?? ""
            let number = catalog.season.flatMap { season in catalog.episode.map { "S\(season):E\($0)" } }
            let line = [show, number].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            if let episode = detail.title, !episode.isEmpty { return (episode, line) }
            return (show.isEmpty ? detail.displayTitle : show, number ?? "")
        }
        return (detail.catalog?.title ?? detail.displayTitle, "")
    }

    // MARK: State

    private func refresh() {
        let newTime = Double(player.time.value?.int64Value ?? 0) / 1000
        let newLength = Double(player.media?.length.value?.int64Value ?? 0) / 1000
        if newTime != time { time = newTime }
        if newLength != length { length = newLength }
        let playing = player.isPlaying
        if playing != isPlaying {
            isPlaying = playing
            if playing { scheduleHide() } else { showControls(autoHide: false) }
        }
        let audio = player.audioTracks.enumerated().map { Track(id: $0.offset, name: $0.element.trackName, selected: $0.element.isSelected) }
        if audio != audioTracks { audioTracks = audio }
        let text = player.textTracks.enumerated().map { Track(id: $0.offset, name: $0.element.trackName, selected: $0.element.isSelected) }
        if text != textTracks { textTracks = text }

        switch player.state {
        case .error:
            if case .failed = phase {} else { phase = .failed("This video can't be played.") }
        case .stopped where length > 0 && time >= length - 5:
            if phase == .playing { finished() }
        default:
            if case .loading = phase, playing || newTime > 0, resumed(at: newTime) {
                phase = .playing
                scheduleHide()
            }
        }
        if playing, Date().timeIntervalSince(lastSave) > 10 {
            lastSave = Date()
            saveProgress(completed: false)
        }
    }

    /// Seeks to the saved position once the file has started, keeping the loading screen up (and the sound off)
    /// until it gets there. True once playback is where it should be.
    private func resumed(at now: Double) -> Bool {
        switch resume {
        case nil:
            return true
        case let .pending(target):
            guard player.isSeekable else { return false }
            player.time = VLCTime(number: NSNumber(value: Int64(target * 1000)))
            resume = .seeking(target, since: Date())
            return false
        case let .seeking(target, since):
            // Give up waiting after a few seconds rather than hold the loading screen forever.
            guard now >= target - 3 || Date().timeIntervalSince(since) > 6 else { return false }
            resume = nil
            player.audio?.isMuted = false
            return true
        }
    }

    private func finished() {
        saveProgress(completed: true)
        if nextAssetId != nil {
            playNext()
        } else {
            phase = .ended
            showControls(autoHide: false)
        }
    }

    // MARK: Transport

    func togglePlay() {
        switch phase {
        case .ended:
            player.time = VLCTime(int: 0)
            phase = .playing
            player.play()
        case .playing:
            if scrubTime != nil {
                commitScrub()
                return
            }
            if player.isPlaying {
                player.pause()
                saveProgress(completed: false)
            } else {
                player.play()
            }
        default:
            return
        }
        showControls()
    }

    func skip(by seconds: Double) {
        guard phase == .playing, player.isSeekable else {
            showControls()
            return
        }
        _ = player.jump(withOffset: Int32(seconds * 1000), completion: nil)
        time = min(max(0, time + seconds), length > 0 ? length : .infinity)
        scrubTime = nil
        skipNotice = seconds > 0 ? 10 : -10
        skipTask?.cancel()
        skipTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            self?.skipNotice = nil
        }
        showControls()
    }

    // MARK: Scrubbing

    /// Swipes on the touch surface. While paused they move a scrub position along the timeline (a full swipe
    /// covers about a tenth of the video, at least two minutes); while playing they just bring up the controls.
    func swipe(_ phase: RemoteSwipe) {
        guard self.phase == .playing else { return }
        switch phase {
        case .began:
            if isPlaying {
                showControls()
            } else {
                scrubBase = scrubTime ?? time
                showControls(autoHide: false)
            }
        case let .changed(translation):
            guard let base = scrubBase, length > 0 else { return }
            let span = max(120, length / 10)
            scrubTime = min(max(0, base + Double(translation) / 1000 * span), length)
        case .ended:
            scrubBase = nil
        }
    }

    /// Jumps to the scrubbed position and plays from there.
    func commitScrub() {
        guard let target = scrubTime else { return }
        player.time = VLCTime(number: NSNumber(value: Int64(target * 1000)))
        time = target
        scrubTime = nil
        scrubBase = nil
        player.play()
        showControls()
    }

    func cancelScrub() {
        scrubTime = nil
        scrubBase = nil
        showControls(autoHide: false)
    }

    func playNext() {
        guard let next = nextAssetId else { return }
        if phase == .playing { saveProgress(completed: true) }
        assetId = next
        startOver = false
        nextAssetId = nil
        loadTask?.cancel()
        loadTask = Task { await load() }
        showControls()
    }

    func selectAudio(_ index: Int) {
        guard player.audioTracks.indices.contains(index) else { return }
        player.audioTracks[index].isSelectedExclusively = true
        refresh()
    }

    func selectText(_ index: Int?) {
        if let index, player.textTracks.indices.contains(index) {
            player.textTracks[index].isSelectedExclusively = true
        } else {
            player.deselectAllTextTracks()
        }
        refresh()
    }

    // MARK: Likes

    /// One more like each click, up to five, then back to none (as in Clips).
    func like() async {
        guard !isLiking else { return }
        isLiking = true
        defer { isLiking = false }
        let id = assetId
        let previous = myLikes
        let target = myLikes >= LikeLevel.maximum ? 0 : myLikes + 1
        myLikes = target
        poke()
        do {
            let result = try await api.setLikes(id, count: target)
            if assetId == id { myLikes = result.myLikes ?? target }
        } catch {
            if assetId == id { myLikes = previous }
        }
    }

    // MARK: Progress

    private func saveProgress(completed: Bool) {
        guard let ms = player.time.value?.intValue, ms > 0 else { return }
        let id = assetId
        Task { [api] in try? await api.saveProgress(id, progressMs: ms, completed: completed) }
    }

    // MARK: Showing and hiding the controls

    /// Any press on the remote: bring the controls up and restart their countdown.
    func poke() {
        if controlsVisible { scheduleHide() } else { showControls() }
    }

    func hideControls() {
        hideTask?.cancel()
        controlsVisible = false
    }

    func showControls(autoHide: Bool = true) {
        if !controlsVisible { controlsVisible = true }
        if autoHide { scheduleHide() } else { hideTask?.cancel() }
    }

    /// Controls fade after a few seconds of playback without a press, never while paused.
    private func scheduleHide() {
        hideTask?.cancel()
        hideTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, let self, self.isPlaying, self.phase == .playing, !self.holdControls else { return }
            self.controlsVisible = false
        }
    }
}
