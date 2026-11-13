import Foundation

/// Loads one browse page's feed (Home, Movies, Videos…) and reloads it quietly after playback.
@Observable
final class BrowseModel {
    enum State { case loading, loaded, empty }

    private(set) var state: State = .loading
    private(set) var feed = Feed(featured: nil, shelves: [])
    private let load: (APIClient) async -> Feed

    init(load: @escaping (APIClient) async -> Feed) {
        self.load = load
    }

    func refresh(_ api: APIClient, quietly: Bool = false) async {
        if !quietly { state = .loading }
        let next = await load(api)
        guard !Task.isCancelled else { return }
        feed = next
        state = next.shelves.isEmpty && next.featured == nil ? .empty : .loaded
    }
}
