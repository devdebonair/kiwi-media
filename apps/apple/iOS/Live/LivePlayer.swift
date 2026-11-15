import AVFoundation
import AVKit
import SwiftUI
import UIKit

/// The Live tab's own player. Channels play inline above the guide instead of in the modal system player, so
/// viewers can keep browsing what's on while they watch. One `PlayerSession` drives it (tuning, re-tuning when
/// a program ends), and the video is drawn into a single long-lived `AVPlayerLayer`, so rotating between the
/// portrait layout and full screen never interrupts playback, and Picture in Picture keeps working.
@Observable
final class LivePlayer {
    private(set) var session: PlayerSession?
    private(set) var isMuted = false
    private(set) var isPlaying = false
    private(set) var isPictureInPicture = false
    /// iPad (and the expand button there): full screen without rotating. iPhone uses landscape for that.
    var isExpanded = false
    /// Double-tap in full screen: crop the video to fill the screen instead of letterboxing it.
    var fillsScreen = false {
        didSet { videoView.playerLayer.videoGravity = fillsScreen ? .resizeAspectFill : .resizeAspect }
    }

    /// Whether the Live tab is the one showing. Picture in Picture closed from elsewhere ends playback.
    @ObservationIgnored var isOnScreen = true
    /// Brings the Live tab back when the viewer expands Picture in Picture.
    @ObservationIgnored var onRestore: () -> Void = {}

    @ObservationIgnored let videoView = LiveVideoView()
    @ObservationIgnored private var pictureInPicture: AVPictureInPictureController?
    @ObservationIgnored private let pipDelegate = PictureInPictureDelegate()
    @ObservationIgnored private var statusObservation: NSKeyValueObservation?
    @ObservationIgnored private var restoring = false

    var isActive: Bool { session != nil }
    var channelKey: String? { session?.channelKey }

    init() {
        pipDelegate.onActiveChange = { [weak self] active in
            guard let self else { return }
            isPictureInPicture = active
            if !active {
                // Closed from the floating window (not expanded back) while another tab is showing.
                if !restoring, !isOnScreen { stop() }
                restoring = false
            }
        }
        pipDelegate.onRestore = { [weak self] in
            self?.restoring = true
            self?.onRestore()
        }
    }

    // MARK: Tuning

    /// Starts watching `key`, or switches to it if something is already playing.
    func tune(_ key: String, api: APIClient) {
        if let session {
            if session.channelKey != key {
                session.tune(to: key)
            } else if case .failed = session.phase {
                session.start()
            }
            return
        }
        let session = PlayerSession(api: api, request: PlayRequest(source: .channel(key)))
        self.session = session
        OrientationLock.allowsLandscape = true
        session.start()
        track(session)
    }

    /// Channel up (+1) or down (-1) through `lineup`, wrapping around. Returns the channel tuned to.
    @discardableResult
    func step(by offset: Int, through lineup: [String]) -> String? {
        guard let session, let current = session.channelKey, !lineup.isEmpty else { return nil }
        let index = lineup.firstIndex(of: current) ?? 0
        let next = lineup[(index + offset + lineup.count) % lineup.count]
        session.tune(to: next)
        return next
    }

    /// Ends playback and releases the player. Safe to call more than once.
    func stop() {
        guard let session else { return }
        if pictureInPicture?.isPictureInPictureActive == true { pictureInPicture?.stopPictureInPicture() }
        session.stop()
        self.session = nil
        attach(nil)
        isExpanded = false
        fillsScreen = false
        OrientationLock.allowsLandscape = false
    }

    // MARK: Controls

    func togglePlayback() {
        guard let player = session?.player else { return }
        if isPlaying { player.pause() } else { player.play() }
    }

    func toggleMute() {
        isMuted.toggle()
        session?.player?.isMuted = isMuted
    }

    var canPictureInPicture: Bool { AVPictureInPictureController.isPictureInPictureSupported() }

    func togglePictureInPicture() {
        guard let pictureInPicture else { return }
        if pictureInPicture.isPictureInPictureActive {
            pictureInPicture.stopPictureInPicture()
        } else {
            pictureInPicture.startPictureInPicture()
        }
    }

    // MARK: Wiring

    /// Follows the session's player: it's replaced on every tune, including when one program rolls into the next.
    private func track(_ session: PlayerSession) {
        withObservationTracking {
            _ = session.player
        } onChange: { [weak self, weak session] in
            Task { @MainActor in
                guard let self, let session, self.session === session else { return }
                self.attach(session.player)
                self.track(session)
            }
        }
        attach(session.player)
    }

    private func attach(_ player: AVPlayer?) {
        guard videoView.player !== player else { return }
        videoView.player = player
        player?.isMuted = isMuted
        statusObservation = player?.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] player, _ in
            let playing = player.timeControlStatus != .paused
            Task { @MainActor in self?.isPlaying = playing }
        }
        if player == nil { isPlaying = false }
        if player != nil, pictureInPicture == nil, canPictureInPicture {
            let controller = AVPictureInPictureController(playerLayer: videoView.playerLayer)
            controller?.delegate = pipDelegate
            // Leaving the app mid-program carries on in the floating window, like the system player.
            controller?.canStartPictureInPictureAutomaticallyFromInline = true
            pictureInPicture = controller
        }
    }
}

/// A view whose backing layer is an `AVPlayerLayer`, so the video resizes with the view during rotation.
final class LiveVideoView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }

    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }

    var player: AVPlayer? {
        get { playerLayer.player }
        set { playerLayer.player = newValue }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        playerLayer.videoGravity = .resizeAspect
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
}

/// Hosts the player's one `LiveVideoView` in SwiftUI.
struct LiveVideoSurface: UIViewRepresentable {
    let view: LiveVideoView

    func makeUIView(context: Context) -> LiveVideoView { view }
    func updateUIView(_ uiView: LiveVideoView, context: Context) {}
}

/// The system AirPlay button.
struct AirPlayButton: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let picker = AVRoutePickerView()
        picker.tintColor = .white
        picker.activeTintColor = UIColor(Theme.accent)
        picker.prioritizesVideoDevices = true
        return picker
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}

private final class PictureInPictureDelegate: NSObject, AVPictureInPictureControllerDelegate {
    var onActiveChange: (Bool) -> Void = { _ in }
    var onRestore: () -> Void = {}

    func pictureInPictureControllerWillStartPictureInPicture(_ controller: AVPictureInPictureController) {
        onActiveChange(true)
    }

    func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
        onActiveChange(false)
    }

    func pictureInPictureController(
        _ controller: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
    ) {
        onRestore()
        completionHandler(true)
    }
}

/// Asks the window scene to rotate, for the expand and collapse buttons on iPhone.
enum DeviceRotation {
    static func request(_ orientations: UIInterfaceOrientationMask) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first else { return }
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: orientations))
    }
}
