import UIKit

/// Title logos for cards. Catalog cards mostly arrive without one, so each title's is looked up the first time
/// it's needed and remembered, including titles that have none, for as long as the app runs.
final class LogoStore {
    static let shared = LogoStore()

    /// Logo paths by title ref; `nil` once a title is known to have no logo.
    private var paths: [String: String?] = [:]
    private var lookups: [String: Task<String?, Error>] = [:]

    /// The logo already in hand for `item`, with no waiting: its image when it has been fetched, or `nil`.
    func cachedImage(for item: TileItem, api: APIClient) -> UIImage? {
        guard let path = knownPath(item), let url = api.url(path) else { return nil }
        return ImageCache.shared.image(for: url)
    }

    /// Whether `item` is known to have no logo, so its name can show straight away.
    func knownToHaveNone(_ item: TileItem) -> Bool {
        guard item.logo == nil, let ref = Self.ref(item), let path = paths[ref] else { return false }
        return path == nil
    }

    /// `item`'s logo image, looking up its path if need be; `nil` when it has none or it can't be fetched.
    func image(for item: TileItem, api: APIClient) async -> UIImage? {
        guard let path = await path(for: item, api: api), let url = api.url(path) else { return nil }
        if let image = ImageCache.shared.image(for: url) { return image }
        return await ImageCache.shared.load(url)
    }

    private func knownPath(_ item: TileItem) -> String? {
        if let logo = item.logo { return logo }
        guard let ref = Self.ref(item) else { return nil }
        return paths[ref] ?? nil
    }

    private func path(for item: TileItem, api: APIClient) async -> String? {
        if let logo = item.logo { return logo }
        guard let ref = Self.ref(item) else { return nil }
        if let known = paths[ref] { return known }
        let lookup = lookups[ref] ?? Task { try await api.logo(ref: ref) }
        lookups[ref] = lookup
        defer { lookups[ref] = nil }
        do {
            let path = try await lookup.value
            paths[ref] = .some(path)
            return path
        } catch {
            // Not remembered, so the title is asked about again next time.
            return nil
        }
    }

    /// The title a card stands for. Only title cards have logos; episodes, videos and channels don't.
    private static func ref(_ item: TileItem) -> String? {
        if case let .title(ref) = item.action { return ref }
        return nil
    }
}
