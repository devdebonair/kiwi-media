import SwiftUI

extension Theme {
    /// Netflix's TV proportions: tall posters a little narrower than 2:3.
    static let posterSize = CGSize(width: 310, height: 500)
    /// A poster in focus opens up to the title's 16:9 artwork, at the same height.
    static let openPosterSize = CGSize(width: 889, height: 500)
    static let landscapeSize = CGSize(width: 480, height: 270)
    static let shelfSpacing: CGFloat = 26
    static let pageInset: CGFloat = 80
}



/// Artwork across the whole screen behind a browse page, shaded the way Netflix does: dark from the left where
/// the text sits, fading into the page at the bottom where the rows sit, and a little darker at the top under the
/// navigation. `subdued` dims it further while the viewer is browsing rows over it.
struct CinematicBackdrop: View {
    let path: String?
    var subdued = false

    var body: some View {
        ZStack {
            Theme.background
            RemoteImage(path: path)
                .id(path)
                .transition(.opacity)
                .opacity(subdued ? 0.6 : 1)
            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0.92), location: 0),
                    .init(color: .black.opacity(0.65), location: 0.28),
                    .init(color: .black.opacity(0.15), location: 0.6),
                    .init(color: .clear, location: 0.8),
                ],
                startPoint: .leading, endPoint: .trailing
            )
            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0.55), location: 0),
                    .init(color: .clear, location: 0.22),
                    .init(color: .clear, location: 0.45),
                    .init(color: Theme.background.opacity(subdued ? 0.9 : 0.7), location: 0.72),
                    .init(color: Theme.background, location: 1),
                ],
                startPoint: .top, endPoint: .bottom
            )
            // A soft glow of light from the top right, as if the artwork were lit from behind.
            RadialGradient(colors: [.clear, .black.opacity(0.35)], center: UnitPoint(x: 0.75, y: 0.25), startRadius: 200, endRadius: 1400)
        }
        .animation(.easeInOut(duration: 0.6), value: path)
        .animation(.easeInOut(duration: 0.4), value: subdued)
        .ignoresSafeArea()
    }
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

/// A capsule action button (Play, More Info, My List), proportioned like Netflix's: the label the same size as
/// the text around it, a small icon, generous padding, and almost no zoom on focus.
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
                .labelStyle(PillLabelStyle())
                .font(.system(size: 27, weight: .semibold))
                .padding(.horizontal, 32)
                .padding(.vertical, 17)
                .foregroundStyle(isFocused || prominent ? Color.black : Color.white)
                .background(
                    Capsule().fill(isFocused ? Color.white : (prominent ? Color.white.opacity(0.85) : Color.white.opacity(0.18)))
                )
                .scaleEffect(isFocused ? 1.03 : (configuration.isPressed ? 0.97 : 1))
                .shadow(color: .black.opacity(isFocused ? 0.35 : 0), radius: 12, y: 6)
                .animation(.easeOut(duration: 0.18), value: isFocused)
        }
    }
}

/// A small icon beside the button's text.
struct PillLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 12) {
            configuration.icon
                .font(.system(size: 22, weight: .bold))
            configuration.title
        }
    }
}

extension View {
    /// The main action on a screen (Play, Connect).
    func primaryAction() -> some View { buttonStyle(PillButtonStyle(prominent: true)) }
    func secondaryAction() -> some View { buttonStyle(PillButtonStyle()) }
}
