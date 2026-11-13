import SwiftUI

extension Theme {
    static let posterSize = CGSize(width: 116, height: 174)
    static let landscapeSize = CGSize(width: 236, height: 133)
    static let shelfSpacing: CGFloat = 10
    static let pageInset: CGFloat = 16
    static let cardRadius: CGFloat = 8
}

/// Netflix-style rectangular action buttons: white for the main action, translucent for the rest.
struct ActionButtonStyle: ButtonStyle {
    var prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .labelStyle(.titleAndIcon)
            .padding(.vertical, 12)
            .padding(.horizontal, 18)
            .foregroundStyle(prominent ? Color.black : Color.white)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(prominent ? Color.white : Color.white.opacity(0.18))
            )
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Rectangle())
    }
}

extension View {
    func primaryAction() -> some View { buttonStyle(ActionButtonStyle(prominent: true)) }
    func secondaryAction() -> some View { buttonStyle(ActionButtonStyle(prominent: false)) }
}

/// The page's ambient glow: the featured artwork, heavily blurred, fading into the background.
struct AmbientBackdrop: View {
    let path: String?

    var body: some View {
        RemoteImage(path: path)
            .frame(height: 520)
            .blur(radius: 60)
            .opacity(0.55)
            .mask(LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom))
            .frame(maxHeight: .infinity, alignment: .top)
            .ignoresSafeArea()
            .animation(.easeInOut(duration: 0.4), value: path)
    }
}
