import AVKit
import SwiftUI

struct PlayerScreen: View {
    @State private var session: PlayerSession
    @Environment(\.dismiss) private var dismiss

    init(api: APIClient, request: PlayRequest) {
        _session = State(initialValue: PlayerSession(api: api, request: request))
    }

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
        .onAppear { session.start() }
        .onDisappear { session.stop() }
    }
}

/// The system tvOS player UI: transport bar, info panel, audio and subtitle menus for HLS. Kiwi adds a Like
/// button to the transport bar, and Channel Up / Down while watching live; live TV can't be scrubbed.
struct SystemPlayer: UIViewControllerRepresentable {
    let player: AVPlayer
    let session: PlayerSession
    /// Passed in (rather than read from `session`) so SwiftUI updates the buttons when they change.
    let myLikes: Int
    let isLive: Bool

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        // Switch the TV to the video's frame rate and dynamic range when "Match Content" is on.
        controller.appliesPreferredDisplayCriteriaAutomatically = true
        configure(controller)
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player { controller.player = player }
        configure(controller)
    }

    private func configure(_ controller: AVPlayerViewController) {
        controller.requiresLinearPlayback = isLive
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
}
