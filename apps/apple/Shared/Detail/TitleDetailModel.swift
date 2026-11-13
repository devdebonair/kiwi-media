import Foundation

@Observable
final class TitleDetailModel {
    enum State: Equatable { case loading, loaded, failed(String) }

    private(set) var state: State = .loading
    private(set) var title: Title?
    private(set) var episodes: [Episode] = []
    private(set) var selectedSeason: Int?
    private(set) var similar: [CatalogCard] = []
    private(set) var isUpdatingList = false
    /// This profile's like level on the title's next-up asset (the movie, or the episode to watch).
    private(set) var myLikes = 0
    private var likedAssetId: String?
    private var isLiking = false

    let ref: String

    init(ref: String) {
        self.ref = ref
    }

    func load(_ api: APIClient) async {
        do {
            // A `tmdb:` ref makes the server create the local title, so use its real id from here on.
            let loaded = try await api.title(ref)
            title = loaded
            state = .loaded
            if loaded.isShow {
                let season = selectedSeason ?? loaded.nextUp?.season ?? Self.firstSeason(loaded)
                if let season { await select(season: season, api) }
            }
            if let next = loaded.nextUp?.id, next != likedAssetId {
                likedAssetId = next
                myLikes = (try? await api.asset(next))?.myLikes ?? 0
            }
            if similar.isEmpty {
                similar = (try? await api.similar(titleId: loaded.id)) ?? []
            }
        } catch {
            if title == nil { state = .failed(error.localizedDescription) }
        }
    }

    func select(season: Int, _ api: APIClient) async {
        guard let title else { return }
        selectedSeason = season
        let loaded = (try? await api.episodes(titleId: title.id, season: season)) ?? []
        if selectedSeason == season { episodes = loaded }
    }

    func toggleWatchList(_ api: APIClient) async {
        guard let title, !isUpdatingList else { return }
        isUpdatingList = true
        defer { isUpdatingList = false }
        if let updated = try? await api.setInWatchList(titleId: title.id, !(title.inLibrary ?? false)) {
            self.title = updated
        }
    }

    /// Adds a like, up to five; at five, another press clears it.
    func like(_ api: APIClient) async {
        guard let id = likedAssetId, !isLiking else { return }
        isLiking = true
        defer { isLiking = false }
        let previous = myLikes
        let target = myLikes >= LikeLevel.maximum ? 0 : myLikes + 1
        myLikes = target
        do {
            myLikes = try await api.setLikes(id, count: target).myLikes ?? target
        } catch {
            myLikes = previous
        }
    }

    private static func firstSeason(_ title: Title) -> Int? {
        let numbers = (title.seasons ?? []).map(\.number)
        return numbers.first { $0 > 0 } ?? numbers.first
    }
}
