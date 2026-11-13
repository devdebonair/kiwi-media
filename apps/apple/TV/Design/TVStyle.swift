import SwiftUI

extension Theme {
    static let posterSize = CGSize(width: 250, height: 375)
    static let landscapeSize = CGSize(width: 420, height: 236)
    static let shelfSpacing: CGFloat = 40
    static let pageInset: CGFloat = 80
}



/// Full-bleed artwork darkened so text on top stays readable, like a streaming app's billboard.
struct BackdropView: View {
    let path: String?

    var body: some View {
        ZStack {
            Theme.background
            RemoteImage(path: path, contentMode: .fill)
                .id(path)
                .transition(.opacity)
            LinearGradient(
                stops: [
                    .init(color: Theme.background.opacity(0.95), location: 0),
                    .init(color: Theme.background.opacity(0.55), location: 0.45),
                    .init(color: .clear, location: 0.8),
                ],
                startPoint: .leading, endPoint: .trailing
            )
            LinearGradient(
                colors: [.clear, Theme.background.opacity(0.85), Theme.background],
                startPoint: UnitPoint(x: 0.5, y: 0.35), endPoint: .bottom
            )
        }
        .animation(.easeInOut(duration: 0.45), value: path)
        .ignoresSafeArea()
    }
}

/// A large capsule action button (Play, More Info, My List).
struct PillButtonStyle: ButtonStyle {
    var prominent = false

    func makeBody(configuration: Configuration) -> some View {
        PillBody(configuration: configuration, prominent: prominent)
    }

    private struct PillBody: View {
        let configuration: ButtonStyleConfiguration
        let prominent: Bool
        @Environment(\.isFocused) private var isFocused

        var body: some View {
            configuration.label
                .font(.headline)
                .padding(.horizontal, 36)
                .padding(.vertical, 18)
                .foregroundStyle(isFocused ? Color.black : Color.white)
                .background(
                    Capsule().fill(isFocused ? Color.white : (prominent ? Color.white.opacity(0.28) : Color.white.opacity(0.14)))
                )
                .scaleEffect(isFocused ? 1.08 : (configuration.isPressed ? 0.96 : 1))
                .shadow(color: .black.opacity(isFocused ? 0.45 : 0), radius: 18, y: 10)
                .animation(.easeOut(duration: 0.18), value: isFocused)
        }
    }
}

extension View {
    /// The main action on a screen (Play, Connect).
    func primaryAction() -> some View { buttonStyle(PillButtonStyle(prominent: true)) }
    func secondaryAction() -> some View { buttonStyle(PillButtonStyle()) }
}
