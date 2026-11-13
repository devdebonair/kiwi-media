import SwiftUI

extension BrowseModel {
    func item(forFocusKey key: String?) -> TileItem? {
        guard let key else { return nil }
        for shelf in feed.shelves {
            for item in shelf.items where ShelfView.focusKey(shelf, item) == key { return item }
        }
        return nil
    }
}

/// A browse page in the style of Netflix's 2025 TV redesign: a large inset billboard at the top that always
/// describes the card in focus, rows of cards beneath it, and a page tinted to match the artwork.
struct BrowseScreen: View {
    let emptyMessage: String
    @State var model: BrowseModel
    /// Shown above the billboard (the profile tab's account bar).
    var header: AnyView?

    @Environment(AppModel.self) private var app
    @FocusState private var focusKey: String?
    /// The card the billboard describes. Stays put while focus is on the billboard's own buttons.
    @State private var shown: TileItem?
    /// The row in focus, kept at the top of the rows area so its heading stays visible.
    @State private var focusedShelf: String?

    private var displayed: TileItem? {
        shown ?? model.feed.featured.map(TileItem.init(featured:)) ?? model.feed.shelves.first?.items.first
    }

    var body: some View {
        ZStack {
            switch model.state {
            case .loading:
                ProgressView().controlSize(.large)
            case .empty:
                ContentUnavailableView("Nothing here yet", systemImage: "film.stack", description: Text(emptyMessage))
            case .loaded:
                VStack(alignment: .leading, spacing: 20) {
                    if let header { header }
                    if let displayed {
                        BillboardPanel(item: displayed)
                            .frame(height: header == nil ? 500 : 400)
                            .focusSection()
                    }
                    ScrollView(.vertical) {
                        // Not lazy: the focus engine can only move down to rows that exist, and only one row fits
                        // below the billboard. Each row's cards are still built lazily.
                        VStack(alignment: .leading, spacing: 26) {
                            ForEach(model.feed.shelves) { shelf in
                                ShelfView(shelf: shelf, focus: $focusKey)
                            }
                        }
                        .scrollTargetLayout()
                        .padding(.top, 10)
                        .padding(.bottom, 80)
                    }
                    .scrollPosition(id: $focusedShelf, anchor: .top)
                    // Clipped, so rows scroll under the billboard's edge rather than over it; rows themselves
                    // leave room for a focused card's lift.
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { TintedBackground(path: displayed?.backdrop ?? displayed?.artwork, height: 1100) }
        .onChange(of: focusKey) { _, key in
            if let item = model.item(forFocusKey: key) {
                withAnimation(.easeInOut(duration: 0.3)) { shown = item }
            }
            if let shelf = key?.split(separator: "|").first.map(String.init), shelf != focusedShelf {
                withAnimation(.easeInOut(duration: 0.3)) { focusedShelf = shelf }
            }
        }
        .task {
            if model.state == .loading { await model.refresh(app.api) }
        }
        .onChange(of: app.playbackGeneration) {
            Task { await model.refresh(app.api, quietly: true) }
        }
    }
}

/// The billboard: wide artwork fading into the title's logo, facts, synopsis and actions.
struct BillboardPanel: View {
    let item: TileItem

    @Environment(AppModel.self) private var app
    @Environment(\.openItem) private var openItem

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Color.black.opacity(0.35)
            RemoteImage(path: item.backdrop ?? item.artwork)
                .id(item.backdrop ?? item.artwork)
                .transition(.opacity)
                .mask(
                    LinearGradient(
                        stops: [.init(color: .clear, location: 0.05), .init(color: .black.opacity(0.85), location: 0.5), .init(color: .black, location: 1)],
                        startPoint: .leading, endPoint: .trailing
                    )
                )
            LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .center, endPoint: .bottom)

            VStack(alignment: .leading, spacing: 16) {
                if case .tune = item.action { LiveBadge() }
                TitleTreatment(title: item.title, logo: item.logo, maxWidth: 560, maxHeight: 150, fontSize: 64, textMaxWidth: 900)
                    .id(item.id)
                if let metadata = item.metadata, !metadata.isEmpty {
                    Text(metadata)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(Theme.secondaryText)
                }
                if let overview = item.overview ?? item.subtitle, !overview.isEmpty {
                    Text(overview)
                        .font(.callout)
                        .lineLimit(2)
                        .frame(maxWidth: 860, alignment: .leading)
                }
                HStack(spacing: 20) {
                    Button(action: play) {
                        Label(playLabel, systemImage: isLive ? "dot.radiowaves.left.and.right" : "play.fill")
                    }
                    .primaryAction()
                    if let ref = item.detailRef {
                        Button {
                            openItem(TileItem(id: ref, title: item.title, action: .title(ref: ref)))
                        } label: {
                            Label("More Info", systemImage: "info.circle")
                        }
                        .secondaryAction()
                    }
                }
                .padding(.top, 6)
            }
            .padding(48)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 36, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 36, style: .continuous).strokeBorder(.white.opacity(0.08)))
        .animation(.easeInOut(duration: 0.35), value: item.id)
    }

    private var isLive: Bool {
        if case .tune = item.action { return true }
        return false
    }

    private var playLabel: String {
        if isLive { return "Watch Live" }
        return item.progress != nil ? "Resume" : "Play"
    }

    private func play() {
        if let id = item.playAssetId {
            app.play(id)
            return
        }
        switch item.action {
        case let .play(assetId): app.play(assetId)
        case let .tune(channel): app.tune(channel)
        case let .title(ref): Task { await app.playTitle(ref) }
        }
    }
}
