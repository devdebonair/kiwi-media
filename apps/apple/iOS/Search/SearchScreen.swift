import SwiftUI

/// Library and catalog search, shown as poster grids plus a list of matching videos.
struct SearchScreen: View {
    @Environment(AppModel.self) private var app
    @State private var query = ""
    @State private var shelves: [Shelf] = []
    @State private var isSearching = false
    @State private var fieldPresented = false

    var body: some View {
        ScrollView(.vertical) {
            LazyVStack(alignment: .leading, spacing: 28) {
                ForEach(shelves) { shelf in
                    VStack(alignment: .leading, spacing: 12) {
                        Text(shelf.title).font(.title3.weight(.bold))
                        if shelf.style == .poster {
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 8)], spacing: 8) {
                                ForEach(shelf.items) { item in
                                    GridPoster(item: item)
                                }
                            }
                        } else {
                            ForEach(shelf.items) { item in
                                VideoRow(item: item)
                            }
                        }
                    }
                    .padding(.horizontal, Theme.pageInset)
                }
            }
            .padding(.vertical, 12)
        }
        .overlay {
            let text = query.trimmingCharacters(in: .whitespaces)
            if isSearching && shelves.isEmpty {
                ProgressView()
            } else if text.isEmpty {
                ContentUnavailableView("Search Kiwi", systemImage: "magnifyingglass", description: Text("Movies, series, anime and your videos."))
            } else if shelves.isEmpty {
                ContentUnavailableView.search(text: text)
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationTitle("Search")
        .searchable(text: $query, isPresented: $fieldPresented, prompt: "Movies, series, videos")
        .onAppear { fieldPresented = true }
        .task(id: query) {
            let text = query.trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else {
                shelves = []
                return
            }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            isSearching = true
            let results = await SearchService.shelves(for: text, app.api)
            guard !Task.isCancelled else { return }
            shelves = results
            isSearching = false
        }
    }
}

private struct GridPoster: View {
    let item: TileItem
    @Environment(\.openItem) private var openItem

    var body: some View {
        Button {
            openItem(item)
        } label: {
            Color.clear
                .aspectRatio(2 / 3, contentMode: .fit)
                .overlay { TileArtwork(item: item) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.title)
    }
}

private struct VideoRow: View {
    let item: TileItem
    @Environment(\.openItem) private var openItem

    var body: some View {
        Button {
            openItem(item)
        } label: {
            HStack(spacing: 12) {
                TileArtwork(item: item, size: CGSize(width: 136, height: 77))
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(2)
                    if let subtitle = item.subtitle {
                        Text(subtitle).font(.caption).foregroundStyle(Theme.secondaryText)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "play.circle").font(.title2)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.title)
    }
}
