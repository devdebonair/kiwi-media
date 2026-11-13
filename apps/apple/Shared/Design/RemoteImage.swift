import SwiftUI
import UIKit

/// Loads artwork from the Kiwi server. Image routes need the profile cookie, which `URLSession.shared`
/// sends on its own. Decoded images are kept in memory so rows don't flash while scrolling.
struct RemoteImage: View {
    let path: String?
    var contentMode: ContentMode = .fill

    @Environment(APIClient.self) private var api
    @State private var image: UIImage?

    var body: some View {
        let url = api.url(path)
        // Drawn in an overlay on a clear view so the image always takes exactly the size it's offered,
        // never its own aspect-filled size (which would push surrounding layout around).
        Color.clear
            .overlay {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: contentMode)
                }
            }
            .clipped()
        .task(id: url) {
            guard let url else {
                image = nil
                return
            }
            if let cached = ImageCache.shared.image(for: url) {
                image = cached
                return
            }
            image = nil
            if let loaded = await ImageCache.shared.load(url) {
                image = loaded
            }
        }
    }
}

final class ImageCache {
    static let shared = ImageCache()

    private let memory: NSCache<NSURL, UIImage> = {
        let cache = NSCache<NSURL, UIImage>()
        cache.totalCostLimit = 300 * 1024 * 1024
        return cache
    }()

    func image(for url: URL) -> UIImage? {
        memory.object(forKey: url as NSURL)
    }

    func load(_ url: URL) async -> UIImage? {
        guard let (data, response) = try? await URLSession.shared.data(from: url),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              let decoded = await Self.decode(data)
        else { return nil }
        let cost = Int(decoded.size.width * decoded.size.height * decoded.scale * decoded.scale * 4)
        memory.setObject(decoded, forKey: url as NSURL, cost: cost)
        return decoded
    }

    @concurrent
    private nonisolated static func decode(_ data: Data) async -> UIImage? {
        UIImage(data: data)?.preparingForDisplay()
    }
}
