import SwiftUI

/// Search results as shelves, using `SearchService`.
struct SearchScreen: View {
    @Environment(AppModel.self) private var app
    @State private var query = ""
    @State private var shelves: [Shelf] = []
    @State private var isSearching = false
    @FocusState private var focusKey: String?

    var body: some View {
        ScrollView(.vertical) {
            LazyVStack(alignment: .leading, spacing: 36) {
                if isSearching && shelves.isEmpty {
                    ProgressView().frame(maxWidth: .infinity)
                } else if shelves.isEmpty && !query.trimmingCharacters(in: .whitespaces).isEmpty {
                    ContentUnavailableView.search(text: query)
                }
                ForEach(shelves) { shelf in
                    ShelfView(shelf: shelf, focus: $focusKey)
                }
            }
            .padding(.bottom, 80)
        }
        .scrollClipDisabled()
        .background(Theme.background.ignoresSafeArea())
        .searchable(text: $query, prompt: "Movies, series, videos")
        .task(id: query) {
            let text = query.trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else {
                shelves = []
                return
            }
            // Debounce typing on the on-screen keyboard.
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            isSearching = true
            let results = await SearchService.shelves(for: text, app.api)
            guard !Task.isCancelled else { return }
            shelves = results
            isSearching = false
        }
    }
}
