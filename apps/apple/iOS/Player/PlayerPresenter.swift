import AVKit
import SwiftUI
import UIKit

/// Plays a request in the system player, presented modally through UIKit rather than from SwiftUI. That gives
/// iPhone viewers the native close button, swipe-down to dismiss, landscape playback and Picture in Picture.
/// `PlayerSession` does the work (finding a source, resuming, saving progress, moving to the next episode).
final class PlayerPresenter: NSObject, AVPlayerViewControllerDelegate {
    static let shared = PlayerPresenter()

    private var session: PlayerSession?
    private var controller: AVPlayerViewController?
    private var onClose: (() -> Void)?
    private var inPictureInPicture = false

    func present(_ request: PlayRequest, api: APIClient, onClose: @escaping () -> Void) {
        finish()
        let session = PlayerSession(api: api, request: request)
        let controller = AVPlayerViewController()
        controller.delegate = self
        controller.allowsPictureInPicturePlayback = true
        controller.modalPresentationStyle = .fullScreen

        // Status shown over the black video area while the server gets the stream ready.
        let status = UIHostingController(rootView: PlayerStatusView(session: session))
        status.view.backgroundColor = .clear
        status.view.isUserInteractionEnabled = false
        if let overlay = controller.contentOverlayView {
            status.view.frame = overlay.bounds
            status.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            overlay.addSubview(status.view)
        }

        self.session = session
        self.controller = controller
        self.onClose = onClose
        OrientationLock.allowsLandscape = true
        Self.topViewController()?.present(controller, animated: true)
        session.start()
        track()
    }

    /// Mirrors the session into the controller whenever its player or phase changes.
    private func track() {
        guard let session else { return }
        withObservationTracking {
            _ = session.player
            _ = session.phase
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.sync()
                self?.track()
            }
        }
        sync()
    }

    private func sync() {
        guard let session, let controller else { return }
        if controller.player !== session.player { controller.player = session.player }
        if case let .failed(message) = session.phase, controller.presentedViewController == nil {
            let alert = UIAlertController(title: "Can't play this right now", message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Try Again", style: .default) { _ in session.start() })
            alert.addAction(UIAlertAction(title: "Close", style: .cancel) { [weak self] _ in
                controller.dismiss(animated: true) { self?.finish() }
            })
            controller.present(alert, animated: true)
        }
    }

    /// Saves progress and releases the player. Safe to call more than once.
    private func finish() {
        guard let session else { return }
        session.stop()
        self.session = nil
        controller = nil
        inPictureInPicture = false
        OrientationLock.allowsLandscape = false
        let onClose = onClose
        self.onClose = nil
        onClose?()
    }

    // MARK: AVPlayerViewControllerDelegate

    /// The viewer closed the player (close button or swipe down). Starting Picture in Picture also ends the
    /// full-screen presentation, but playback carries on there.
    func playerViewController(
        _ playerViewController: AVPlayerViewController,
        willEndFullScreenPresentationWithAnimationCoordinator coordinator: any UIViewControllerTransitionCoordinator
    ) {
        coordinator.animate(alongsideTransition: nil) { [weak self] context in
            guard let self, !context.isCancelled, !self.inPictureInPicture else { return }
            self.finish()
        }
    }

    func playerViewControllerWillStartPictureInPicture(_ playerViewController: AVPlayerViewController) {
        inPictureInPicture = true
    }

    func playerViewControllerDidStopPictureInPicture(_ playerViewController: AVPlayerViewController) {
        inPictureInPicture = false
        // Closed from the Picture in Picture window rather than expanded back to full screen.
        if playerViewController.presentingViewController == nil { finish() }
    }

    func playerViewController(
        _ playerViewController: AVPlayerViewController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
    ) {
        guard playerViewController.presentingViewController == nil, let top = Self.topViewController() else {
            completionHandler(true)
            return
        }
        OrientationLock.allowsLandscape = true
        top.present(playerViewController, animated: true) { completionHandler(true) }
    }

    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.keyWindow?.rootViewController
        while let presented = top?.presentedViewController { top = presented }
        return top
    }
}

/// "Finding the best source…" while the stream is prepared.
private struct PlayerStatusView: View {
    let session: PlayerSession

    var body: some View {
        if case let .preparing(message) = session.phase {
            VStack(spacing: 14) {
                ProgressView().controlSize(.large).tint(.white)
                if !session.heading.isEmpty {
                    Text(session.heading)
                        .font(.headline)
                        .multilineTextAlignment(.center)
                }
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.7))
            }
            .foregroundStyle(.white)
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// Browsing stays portrait on iPhone; the player may rotate to landscape.
enum OrientationLock {
    static var allowsLandscape = false {
        didSet {
            guard allowsLandscape != oldValue else { return }
            for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
                scene.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
            }
        }
    }

    static var supported: UIInterfaceOrientationMask {
        if UIDevice.current.userInterfaceIdiom == .pad { return .all }
        return allowsLandscape ? .allButUpsideDown : .portrait
    }
}

final class KiwiAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        OrientationLock.supported
    }
}
