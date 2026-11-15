import SwiftUI

/// A browse page with the feel of Peacock's and Netflix's TV apps. The featured title fills the screen: its
/// artwork runs edge to edge behind its logo, story and Play button, with the first row resting over the bottom
/// of it. Moving into the rows lets the billboard go, lifts the row in focus to the top, and the artwork behind
/// the page becomes that of the card in focus; that card opens up wide and its details appear under its row.
struct BrowseScreen: View {
    let emptyMessage: String
    @State var model: BrowseModel
    /// Shown at the top instead of a billboard (the profile tab's account bar).
    var header: AnyView?

    @Environment(AppModel.self) private var app
    @FocusState private var focusKey: String?
    /// The row in focus, scrolled to the top of the screen; `top` while focus is on the billboard.
    @State private var scrolledTo: String?

    private static let top = "top"

    private var atTop: Bool { scrolledTo == nil || scrolledTo == Self.top }

    private var featured: TileItem? { model.feed.featured.map(TileItem.init(featured:)) }

    /// Full-size artwork behind the billboard. Once focus moves down into the rows the page goes black, so the
    /// cards stand out on their own, as on Netflix.
    private var backdropPath: String? {
        guard atTop else { return nil }
        if let featured { return featured.backdrop?.replacingOccurrences(of: "/w1280/", with: "/original/") }
        return model.feed.shelves.first?.items.first.flatMap { $0.backdrop ?? $0.artwork }
    }

    var body: some View {
        ZStack {
            CinematicBackdrop(path: backdropPath, subdued: !atTop || featured == nil)
            switch model.state {
            case .loading:
                ProgressView().controlSize(.large)
            case .empty:
                ContentUnavailableView("Nothing here yet", systemImage: "film.stack", description: Text(emptyMessage))
            case .loaded:
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: 36) {
                        Group {
                            if let header {
                                header.padding(.horizontal, Theme.pageInset)
                            } else if let featured {
                                HeroBillboard(item: featured)
                                    .frame(height: 620, alignment: .bottomLeading)
                                    .padding(.horizontal, Theme.pageInset)
                            }
                        }
                        .focusSection()
                        // Gone once focus moves into the rows, as on Netflix. Faded while drawing rather than
                        // with `.opacity`: a fully transparent view can't take focus, so Up from the first row would
                        // have nowhere to go (not even the tab bar).
                        .visualEffect { content, _ in content.opacity(atTop ? 1 : 0) }
                        .animation(.easeInOut(duration: 0.3), value: atTop)
                        .id(Self.top)

                        // Not lazy: the focus engine can only move down to rows that exist. Each row's cards are
                        // still built lazily.
                        ForEach(model.feed.shelves) { shelf in
                            ShelfView(shelf: shelf, focus: $focusKey, inset: Theme.pageInset)
                                .id(shelf.id)
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.bottom, 500)
                }
                .scrollPosition(id: $scrolledTo, anchor: .top)
                .scrollClipDisabled()
                .ignoresSafeArea(edges: .horizontal)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onChange(of: focusKey) { _, key in
            let shelf = key?.split(separator: "|").first.map(String.init) ?? Self.top
            if shelf != scrolledTo {
                withAnimation(.easeInOut(duration: 0.35)) { scrolledTo = shelf }
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

/// The featured title over its own artwork: logo, facts, story and actions, in the lower left.
struct HeroBillboard: View {
    let item: TileItem

    @Environment(AppModel.self) private var app
    @Environment(\.openItem) private var openItem
    /// My List changes made from this billboard, by title, until the page reloads.
    @State private var listChanges: [String: Bool] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if case .tune = item.action { LiveBadge() }
            TitleTreatment(title: item.title, logo: item.logo, maxWidth: 560, maxHeight: 170, fontSize: 72, textMaxWidth: 900)
                .padding(.bottom, 4)
            if let metadata = item.metadata, !metadata.isEmpty {
                Text(metadata)
                    .font(.system(size: 25, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.9))
            }
            if let overview = item.overview ?? item.subtitle, !overview.isEmpty {
                Text(overview)
                    .font(.system(size: 27))
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(3)
                    .lineSpacing(3)
                    .frame(maxWidth: 760, alignment: .leading)
            }
            HStack(spacing: 18) {
                Button(action: play) {
                    Label(playLabel, systemImage: isLive ? "dot.radiowaves.left.and.right" : "play.fill")
                }
                .buttonStyle(PillButtonStyle(prominent: true))
                if let ref = item.detailRef {
                    Button {
                        openItem(TileItem(id: ref, title: item.title, action: .title(ref: ref)))
                    } label: {
                        Text("More Info")
                    }
                    .secondaryAction()
                }
                if let titleId = item.titleId {
                    Button {
                        Task { await toggleList(titleId) }
                    } label: {
                        Label("My List", systemImage: isInList(titleId) ? "checkmark" : "plus")
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .secondaryAction()
                }
            }
            .padding(.top, 10)
        }
        .shadow(color: .black.opacity(0.4), radius: 16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var isLive: Bool {
        if case .tune = item.action { return true }
        return false
    }

    private func isInList(_ titleId: String) -> Bool {
        listChanges[titleId] ?? item.inLibrary ?? false
    }

    private func toggleList(_ titleId: String) async {
        let target = !isInList(titleId)
        listChanges[titleId] = target
        if let updated = try? await app.api.setInWatchList(titleId: titleId, target) {
            listChanges[titleId] = updated.inLibrary ?? target
        } else {
            listChanges[titleId] = !target
        }
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
