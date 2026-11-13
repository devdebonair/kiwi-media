import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// A dark, saturated tint taken from a piece of artwork, used to color the page behind it the way Netflix
/// tints its home screen to match the featured title.
enum ArtworkTint {
    private static var cache: [URL: Color] = [:]

    static func color(for url: URL) async -> Color? {
        if let cached = cache[url] { return cached }
        let image: UIImage? = if let cached = ImageCache.shared.image(for: url) { cached } else { await ImageCache.shared.load(url) }
        guard let image, let rgb = await average(image) else { return nil }
        let color = tint(from: rgb)
        cache[url] = color
        return color
    }

    /// Keeps the hue, lifts the saturation and fixes the brightness, so every tint reads as a deep color
    /// that white text sits well on.
    static func tint(from rgb: (red: Double, green: Double, blue: Double)) -> Color {
        let ui = UIColor(red: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
        var hue: CGFloat = 0, saturation: CGFloat = 0, brightness: CGFloat = 0, alpha: CGFloat = 0
        ui.getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha)
        let boosted = saturation < 0.08 ? saturation : min(0.85, saturation * 1.5 + 0.1)
        return Color(hue: hue, saturation: boosted, brightness: 0.36)
    }

    @concurrent
    private nonisolated static func average(_ image: UIImage) async -> (red: Double, green: Double, blue: Double)? {
        guard let input = CIImage(image: image) else { return nil }
        let filter = CIFilter.areaAverage()
        filter.inputImage = input
        filter.extent = input.extent
        guard let output = filter.outputImage else { return nil }
        var pixel = [UInt8](repeating: 0, count: 4)
        CIContext(options: [.workingColorSpace: NSNull()])
            .render(output, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8, colorSpace: nil)
        return (Double(pixel[0]) / 255, Double(pixel[1]) / 255, Double(pixel[2]) / 255)
    }
}

/// A page background that fades from the artwork's tint at the top into the app's near-black.
struct TintedBackground: View {
    let path: String?
    var height: CGFloat = 700

    @Environment(APIClient.self) private var api
    @State private var tint: Color?

    var body: some View {
        ZStack(alignment: .top) {
            Theme.background
            LinearGradient(
                colors: [(tint ?? Theme.placeholder), (tint ?? Theme.placeholder).opacity(0.45), Theme.background],
                startPoint: .top, endPoint: .bottom
            )
            .frame(height: height)
        }
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 0.6), value: tint)
        .task(id: path) {
            guard let url = api.url(path) else { return }
            if let color = await ArtworkTint.color(for: url) { tint = color }
        }
    }
}
