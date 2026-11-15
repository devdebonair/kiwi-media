import SwiftUI
import UIKit
import VLCKit

/// Plays an asset's original file with VLCKit 4, with no server conversion, behind controls styled like the
/// system player. Turned on by launching the app once with `-KiwiVLCSpike YES` (and off with
/// `-KiwiVLCSpike NO`); the choice is remembered, so the app keeps using it when opened from the home screen.
/// While it's off, and always for live channels, `PlayerPresenter` uses the system player.
enum VLCSpike {
    private static let savedKey = "KiwiVLCSpikeEnabled"

    static var isEnabled: Bool {
        let defaults = UserDefaults.standard
        if let value = defaults.volatileDomain(forName: UserDefaults.argumentDomain)["KiwiVLCSpike"] as? NSString {
            defaults.set(value.boolValue, forKey: savedKey)
        }
        return defaults.bool(forKey: savedKey)
    }
}

/// Full-screen host: the VLC video view with `VLCPlayerControls` on top.
final class VLCPlayerController: UIViewController {
    private let api: APIClient
    private let assetId: String
    private let startOver: Bool
    private let onClose: () -> Void

    private let library: VLCLibrary
    private let player: VLCMediaPlayer
    private let bridge: VLCPlayerBridge
    private let model: VLCPlaybackModel
    private let videoView = UIView()
    private var timer: Timer?
    private var loadTask: Task<Void, Never>?

    init(api: APIClient, assetId: String, startOver: Bool, onClose: @escaping () -> Void) {
        self.api = api
        self.assetId = assetId
        self.startOver = startOver
        self.onClose = onClose
        let logger = VLCConsoleLogger()
        logger.level = .warning
        library = VLCLibrary()
        library.loggers = [logger]
        player = VLCMediaPlayer(library: library)
        bridge = VLCPlayerBridge(player: player)
        model = VLCPlaybackModel(player: player, bridge: bridge)
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        model.onClose = { [weak self] in self?.close() }
        model.onSave = { [weak self] completed in self?.saveProgress(completed: completed) }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        videoView.backgroundColor = .black
        videoView.frame = view.bounds
        videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(videoView)
        bridge.attach(videoView)
        player.drawable = bridge
        player.delegate = bridge
        bridge.onStateChange = { [weak self] in self?.model.refresh() }

        let controls = UIHostingController(rootView: VLCPlayerControls(model: model))
        controls.view.backgroundColor = .clear
        addChild(controls)
        controls.view.frame = view.bounds
        controls.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(controls.view)
        controls.didMove(toParent: self)

        let touches = TouchTracker()
        touches.onChange = { [weak self] down in self?.model.setTouching(down) }
        view.addGestureRecognizer(touches)

        loadTask = Task { await load() }
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.model.refresh() }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        bridge.updateBounds(videoView.bounds)
    }

    // MARK: Loading

    private func load() async {
        do {
            let detail = try await api.asset(assetId)
            (model.title, model.subtitle) = Self.titles(for: detail)
            // Catalog titles need the server to find a source first, as with the system player.
            for _ in 0..<180 {
                let (info, code) = try await api.prepareStream(assetId)
                if code != 202 || info.status == "ready" { break }
                model.phase = .loading(info.stage ?? "Getting this ready…")
                try await Task.sleep(for: .seconds(1))
            }
            guard let url = api.url("/api/v1/assets/\(APIClient.segment(assetId))/file"), let media = VLCMedia(url: url) else {
                throw APIError.noServer
            }
            if let host = url.host() {
                for cookie in api.cookies() { media.storeCookie("\(cookie.name)=\(cookie.value)", forHost: host, path: "/") }
            }
            let start = PlayerSession.resumePoint(detail, startOver: startOver)
            if start > 0 { media.addOption(":start-time=\(start)") }
            player.media = media
            player.play()
            print("[VLCPlayer] playing \(url.absoluteString) from \(start)s")
        } catch is CancellationError {
        } catch {
            model.phase = .failed(error.localizedDescription)
            print("[VLCPlayer] load failed: \(error)")
        }
    }

    /// Title and subtitle the way the system player shows them: the episode, then the show and its number.
    private static func titles(for detail: Asset) -> (String, String) {
        if let catalog = detail.catalog, catalog.type == "show" {
            let show = catalog.title ?? ""
            let number = catalog.season.flatMap { season in catalog.episode.map { "S\(season), E\($0)" } }
            return (detail.title ?? show, [show, number].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
        }
        return (detail.catalog?.title ?? detail.displayTitle, "")
    }

    // MARK: Progress and closing

    private func saveProgress(completed: Bool) {
        guard let ms = player.time.value?.intValue, ms > 0 else { return }
        let id = assetId
        Task { [api] in try? await api.saveProgress(id, progressMs: ms, completed: completed) }
    }

    private func close() {
        loadTask?.cancel()
        timer?.invalidate()
        saveProgress(completed: false)
        bridge.pipController?.stopPictureInPicture()
        player.stop()
        OrientationLock.allowsLandscape = false
        dismiss(animated: true) { [onClose] in onClose() }
    }
}

/// What the controls show and do. Polled from the player a few times a second.
@Observable
final class VLCPlaybackModel {
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

    var phase: Phase = .loading("Loading…")
    var title = ""
    var subtitle = ""
    private(set) var time: Double = 0
    private(set) var length: Double = 0
    private(set) var isPlaying = false
    private(set) var isSeekable = false
    private(set) var pipAvailable = false
    private(set) var audioTracks: [Track] = []
    private(set) var textTracks: [Track] = []
    private(set) var rate: Float = 1
    private(set) var fills = false
    private(set) var controlsVisible = true
    /// Where the scrubber is while it's being dragged, in seconds.
    private(set) var scrubTime: Double?

    @ObservationIgnored var onClose: () -> Void = {}
    @ObservationIgnored var onSave: (Bool) -> Void = { _ in }
    @ObservationIgnored private let player: VLCMediaPlayer
    @ObservationIgnored private let bridge: VLCPlayerBridge
    @ObservationIgnored private var hideTask: Task<Void, Never>?
    /// A finger is on the screen: on a button, the volume slider, the timeline or the video.
    @ObservationIgnored private var touching = false
    /// The ••• menu (or one of its submenus) is open.
    @ObservationIgnored private var menuOpen = false
    @ObservationIgnored private var lastSave = Date()

    init(player: VLCMediaPlayer, bridge: VLCPlayerBridge) {
        self.player = player
        self.bridge = bridge
    }

    /// Time shown on the scrubber: the drag position while scrubbing.
    var displayTime: Double { scrubTime ?? time }

    func refresh() {
        let newTime = Double(player.time.value?.int64Value ?? 0) / 1000
        let newLength = Double(player.media?.length.value?.int64Value ?? 0) / 1000
        if newTime != time { time = newTime }
        if newLength != length { length = newLength }
        let playing = player.isPlaying
        if playing != isPlaying {
            isPlaying = playing
            if playing { scheduleHide() } else { showControls(autoHide: false) }
        }
        if player.isSeekable != isSeekable { isSeekable = player.isSeekable }
        let pip = bridge.pipController != nil
        if pip != pipAvailable { pipAvailable = pip }
        let audio = player.audioTracks.enumerated().map { Track(id: $0.offset, name: $0.element.trackName, selected: $0.element.isSelected) }
        if audio != audioTracks { audioTracks = audio }
        let text = player.textTracks.enumerated().map { Track(id: $0.offset, name: $0.element.trackName, selected: $0.element.isSelected) }
        if text != textTracks { textTracks = text }

        switch player.state {
        case .error:
            if case .failed = phase {} else { phase = .failed("This video can't be played.") }
        case .stopped where length > 0 && time >= length - 5:
            if phase != .ended {
                phase = .ended
                onSave(true)
                showControls(autoHide: false)
            }
        default:
            if case .loading = phase, playing || newTime > 0 { phase = .playing }
        }
        if playing, Date().timeIntervalSince(lastSave) > 10 {
            lastSave = Date()
            onSave(false)
        }
    }

    // MARK: Transport

    func togglePlay() {
        if phase == .ended {
            player.time = VLCTime(int: 0)
            phase = .playing
            player.play()
        } else if player.isPlaying {
            player.pause()
            onSave(false)
        } else {
            player.play()
        }
        showControls()
    }

    /// `revealControls` is false for double-tap skips, which show their own feedback instead.
    func skip(by seconds: Double, revealControls: Bool = true) {
        guard isSeekable else { return }
        _ = player.jump(withOffset: Int32(seconds * 1000), completion: nil)
        time = min(max(0, time + seconds), length > 0 ? length : .infinity)
        if revealControls { showControls() } else if controlsVisible { scheduleHide() }
    }

    func scrub(toFraction fraction: Double) {
        guard length > 0 else { return }
        scrubTime = min(max(0, fraction), 1) * length
        hideTask?.cancel()
    }

    func endScrub() {
        guard let target = scrubTime else { return }
        player.time = VLCTime(number: NSNumber(value: Int64(target * 1000)))
        time = target
        scrubTime = nil
        showControls()
    }

    func setRate(_ value: Float) {
        player.rate = value
        rate = value
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

    /// Fill the screen (cropping) or fit the whole picture, like pinching the system player.
    func setFill(_ fill: Bool) {
        fills = fill
        player.videoFitMode = fill ? .larger : .smaller
    }

    func startPictureInPicture() {
        bridge.pipController?.startPictureInPicture()
    }

    func close() { onClose() }

    // MARK: Showing and hiding the controls

    func toggleControls() {
        if controlsVisible, isPlaying { hideControls() } else { showControls() }
    }

    func showControls(autoHide: Bool = true) {
        if !controlsVisible { controlsVisible = true }
        if autoHide { scheduleHide() } else { hideTask?.cancel() }
    }

    /// Fingers on the screen hold the controls up; lifting the last one starts the countdown again.
    func setTouching(_ down: Bool) {
        touching = down
        if down { hideTask?.cancel() } else if controlsVisible { scheduleHide() }
    }

    /// The controls stay up while the ••• menu is open, and start their countdown when it closes.
    func setMenuOpen(_ open: Bool) {
        menuOpen = open
        showControls(autoHide: !open)
    }

    private func hideControls() {
        hideTask?.cancel()
        controlsVisible = false
    }

    /// Like the system player: controls fade after a few seconds of playback without a touch, never while
    /// a finger is down, the timeline is being dragged or the menu is open.
    private func scheduleHide() {
        hideTask?.cancel()
        hideTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3.5))
            guard !Task.isCancelled, let self, self.isPlaying, self.scrubTime == nil, !self.touching, !self.menuOpen else { return }
            self.controlsVisible = false
        }
    }
}

/// Reports when the first finger goes down on the player and when the last one lifts. It never recognizes
/// anything or delays touches, so buttons, sliders and the SwiftUI gestures underneath work as before.
private final class TouchTracker: UIGestureRecognizer, UIGestureRecognizerDelegate {
    var onChange: (Bool) -> Void = { _ in }
    private var active: Set<UITouch> = []

    init() {
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        delegate = self
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if active.isEmpty { onChange(true) }
        active.formUnion(touches)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { lift(touches) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { lift(touches) }

    override func reset() {
        super.reset()
        if !active.isEmpty {
            active.removeAll()
            onChange(false)
        }
    }

    private func lift(_ touches: Set<UITouch>) {
        active.subtract(touches)
        guard active.isEmpty else { return }
        onChange(false)
        state = .failed
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}

/// VLCKit's drawable and Picture in Picture hooks. VLCKit may call these from its own threads, so they're
/// nonisolated: the view is touched only on the main thread, and bounds are cached for other threads.
final class VLCPlayerBridge: NSObject, VLCDrawable, VLCPictureInPictureDrawable, VLCPictureInPictureMediaControlling, VLCMediaPlayerDelegate, @unchecked Sendable {
    nonisolated(unsafe) private let player: VLCMediaPlayer
    nonisolated(unsafe) private weak var view: UIView?
    private let lock = NSLock()
    nonisolated(unsafe) private var cachedBounds = CGRect.zero
    nonisolated(unsafe) private var pip: (any VLCPictureInPictureWindowControlling)?
    @MainActor var onStateChange: (() -> Void)?

    nonisolated init(player: VLCMediaPlayer) {
        self.player = player
    }

    @MainActor func attach(_ view: UIView) {
        self.view = view
        updateBounds(view.bounds)
    }

    @MainActor func updateBounds(_ bounds: CGRect) {
        lock.withLock { cachedBounds = bounds }
    }

    nonisolated var pipController: (any VLCPictureInPictureWindowControlling)? { lock.withLock { pip } }

    private nonisolated func onMain(_ work: @escaping @MainActor () -> Void) {
        if Thread.isMainThread { MainActor.assumeIsolated(work) } else { DispatchQueue.main.async(execute: work) }
    }

    // VLCDrawable
    nonisolated func addSubview(_ subview: UIView) {
        onMain { [weak self] in
            guard let view = self?.view else { return }
            subview.frame = view.bounds
            subview.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(subview)
        }
    }

    nonisolated func bounds() -> CGRect { lock.withLock { cachedBounds } }

    // VLCPictureInPictureDrawable
    nonisolated func mediaController() -> any VLCPictureInPictureMediaControlling { self }

    nonisolated func pictureInPictureReady() -> (((any VLCPictureInPictureWindowControlling)?) -> Void)? {
        { [weak self] controller in
            guard let self, let controller else { return }
            lock.withLock { pip = controller }
            onMain { [weak self] in self?.onStateChange?() }
        }
    }

    // VLCPictureInPictureMediaControlling
    nonisolated func play() { player.play() }
    nonisolated func pause() { player.pause() }
    nonisolated func seek(by offset: Int64, completion: @escaping () -> Void) {
        _ = player.jump(withOffset: Int32(clamping: offset), completion: completion)
    }
    nonisolated func mediaLength() -> Int64 { player.media?.length.value?.int64Value ?? 0 }
    nonisolated func mediaTime() -> Int64 { player.time.value?.int64Value ?? 0 }
    nonisolated func isMediaSeekable() -> Bool { player.isSeekable }
    nonisolated func isMediaPlaying() -> Bool { player.isPlaying }

    // VLCMediaPlayerDelegate
    nonisolated func mediaPlayerStateChanged(_ newState: VLCMediaPlayerState) {
        let pip = pipController
        onMain { [weak self] in
            pip?.invalidatePlaybackState()
            self?.onStateChange?()
        }
    }

    nonisolated func mediaPlayerLengthChanged(_ length: Int64) {
        let pip = pipController
        onMain { pip?.invalidatePlaybackState() }
    }
}
