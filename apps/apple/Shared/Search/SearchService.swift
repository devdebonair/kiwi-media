import Foundation

/// Searches the library and the TMDB catalog together, like the web app: local titles first, then catalog
/// titles that aren't already in the library, then library videos.
enum SearchService {
    static func shelves(for text: String, _ api: APIClient) async -> [Shelf] {
        async let local = try? api.search(text)
        async let catalog = try? api.catalogSearch(text)

        var titles: [TileItem] = []
        var videos: [TileItem] = []
        var localTitleIds = Set<String>()
        for result in await local ?? [] {
            switch result {
            case let .title(title):
                localTitleIds.insert(title.id)
                titles.append(TileItem(searchTitle: title))
            case let .asset(asset) where asset.titleId == nil && (asset.kind ?? "video") == "video":
                videos.append(TileItem(video: asset))
            default:
                break
            }
        }
        let more = (await catalog ?? [])
            .filter { card in card.titleId.map { !localTitleIds.contains($0) } ?? true }
            .map(TileItem.init(card:))

        return [
            Shelf(id: "titles", title: "In Your Library", style: .poster, items: titles),
            Shelf(id: "catalog", title: "Movies & Series", style: .poster, items: more),
            Shelf(id: "videos", title: "Videos", style: .landscape, items: videos),
        ].filter { !$0.items.isEmpty }
    }
}
