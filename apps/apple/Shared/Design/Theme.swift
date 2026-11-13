import SwiftUI

/// Colors shared by the Apple TV and iPhone apps. Each platform adds its own sizes in an extension.
enum Theme {
    /// Kiwi green, matching the web app's default profile color.
    static let accent = Color(red: 0.184, green: 0.620, blue: 0.420)
    static let background = Color(red: 0.035, green: 0.039, blue: 0.047)
    static let placeholder = Color(white: 0.16)
    static let secondaryText = Color(white: 0.72)
}

extension Color {
    /// `#rgb` / `#rrggbb` strings from the API (profile colors).
    init(hex: String?, fallback: Color = Theme.accent) {
        guard var value = hex?.trimmingCharacters(in: .whitespaces), value.hasPrefix("#") else {
            self = fallback
            return
        }
        value.removeFirst()
        if value.count == 3 { value = value.map { "\($0)\($0)" }.joined() }
        guard value.count == 6, let number = UInt32(value, radix: 16) else {
            self = fallback
            return
        }
        self = Color(
            red: Double((number >> 16) & 0xFF) / 255,
            green: Double((number >> 8) & 0xFF) / 255,
            blue: Double(number & 0xFF) / 255
        )
    }
}
