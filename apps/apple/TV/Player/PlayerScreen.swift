import AVKit
import SwiftUI

/// The Live tab's channel, full screen. The session belongs to `LivePlayer`, so going back to the guide leaves
/// the channel playing in the preview there.
struct LivePlayerScreen: View {
    let session: PlayerSession

    var body: some View {
        PlayerSurface(session: session)
    }
}

/// A session on screen: its loading message, the video, or what went wrong.
private struct PlayerSurface: View {
    let session: PlayerSession
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            switch session.phase {
            case let .preparing(message):
                VStack(spacing: 28) {
                    ProgressView().controlSize(.large)
                    if !session.heading.isEmpty {
                        Text(session.heading).font(.title3.weight(.semibold))
                    }
                    Text(message).foregroundStyle(Theme.secondaryText)
                }
            case .playing:
                if let player = session.player {
                    SystemPlayer(player: player, session: session, myLikes: session.myLikes, isLive: session.isLive)
                        .ignoresSafeArea()
                }
            case let .failed(message):
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
                        Button("Try Again") { session.start() }
                            .primaryAction()
                        Button("Close") { dismiss() }
                            .secondaryAction()
                    }
                }
            }
        }
    }
}

/// The system tvOS player UI: transport bar, info panel, audio and subtitle menus for HLS. Kiwi adds a Like
/// button to the transport bar. Live TV can't be scrubbed; instead, swiping up or down on the remote changes
/// channel, as it does on iPhone, and the transport bar has Channel Up / Down too.
struct SystemPlayer: UIViewControllerRepresentable {
    let player: AVPlayer
    let session: PlayerSession
    /// Passed in (rather than read from `session`) so SwiftUI updates the buttons when they change.
    let myLikes: Int
    let isLive: Bool

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        // Switch the TV to the video's frame rate and dynamic range when "Match Content" is on.
        controller.appliesPreferredDisplayCriteriaAutomatically = true
        // No Info tab under the timeline (the on-demand player has none either).
        controller.playbackControlsIncludeInfoViews = false
        configure(controller, context.coordinator)
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player { controller.player = player }
        configure(controller, context.coordinator)
    }

    private func configure(_ controller: AVPlayerViewController, _ coordinator: Coordinator) {
        controller.requiresLinearPlayback = isLive
        // Only live TV has channels to flip through; elsewhere the swipes keep their usual meaning.
        controller.delegate = isLive ? coordinator : nil
        let session = session
        let liked = myLikes > 0
        let like = UIAction(
            title: myLikes >= LikeLevel.maximum ? LikeLevel.label(myLikes) : (liked ? "\(LikeLevel.label(myLikes)) · Like More" : "Like"),
            image: UIImage(systemName: liked ? "heart.fill" : "heart")
        ) { _ in
            Task { @MainActor in await session.like() }
        }
        var items: [UIMenuElement] = [like]
        if isLive {
            items.insert(UIAction(title: "Channel Down", image: UIImage(systemName: "chevron.down")) { _ in
                Task { @MainActor in session.changeChannel(by: 1) }
            }, at: 0)
            items.insert(UIAction(title: "Channel Up", image: UIImage(systemName: "chevron.up")) { _ in
                Task { @MainActor in session.changeChannel(by: -1) }
            }, at: 0)
        }
        controller.transportBarCustomMenuItems = items
    }

    final class Coordinator: NSObject, AVPlayerViewControllerDelegate {
        let session: PlayerSession

        init(session: PlayerSession) {
            self.session = session
        }

        func playerViewController(_ playerViewController: AVPlayerViewController, skipToNextChannel completion: @escaping (Bool) -> Void) {
            session.changeChannel(by: 1)
            completion(true)
        }

        func playerViewController(_ playerViewController: AVPlayerViewController, skipToPreviousChannel completion: @escaping (Bool) -> Void) {
            session.changeChannel(by: -1)
            completion(true)
        }
    }
}
