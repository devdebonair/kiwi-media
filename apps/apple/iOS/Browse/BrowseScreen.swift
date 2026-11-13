import SwiftUI

/// A category page reached from Home's chips (Series, Movies, Anime, Videos).
struct CategoryRoute: Hashable {
    let kind: String
    let title: String
}

/// A browse page: a featured hero card, then rows of cards, over a background tinted to match the hero.
/// Home gets Netflix's header (logo, page name, profile) and category chips instead of a navigation bar.
struct BrowseScreen: View {
    let title: String
    var isHome = false
    let emptyMessage: String
    @State var model: BrowseModel

    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 24) {
                if isHome {
                    HomeHeader(title: title)
                }
                if let featured = model.feed.featured {
                    HeroCard(item: featured)
                        .padding(.horizontal, Theme.pageInset)
                }
                ForEach(model.feed.shelves) { shelf in
                    ShelfRow(shelf: shelf)
                }
            }
            .padding(.top, isHome ? 0 : 8)
            .padding(.bottom, 32)
        }
        .background {
            TintedBackground(path: model.feed.featured?.backdrop ?? model.feed.shelves.first?.items.first?.backdrop)
        }
        .overlay {
            switch model.state {
            case .loading:
                ProgressView().controlSize(.large)
            case .empty:
                ContentUnavailableView("Nothing here yet", systemImage: "film.stack", description: Text(emptyMessage))
            case .loaded:
                EmptyView()
            }
        }
        .navigationTitle(title)
        .toolbar(isHome ? .hidden : .automatic, for: .navigationBar)
        .toolbar {
            if !isHome { ToolbarItem(placement: .topBarTrailing) { ProfileMenu() } }
        }
        .refreshable { await model.refresh(app.api, quietly: true) }
        .task {
            if model.state == .loading { await model.refresh(app.api) }
        }
        .onChange(of: app.playbackGeneration) {
            Task { await model.refresh(app.api, quietly: true) }
        }
    }
}

/// Netflix's home header: the brand mark and page name, the profile on the right, category chips below.
private struct HomeHeader: View {
    let title: String

    private let categories = [
        CategoryRoute(kind: "shows", title: "Series"),
        CategoryRoute(kind: "movies", title: "Movies"),
        CategoryRoute(kind: "anime", title: "Anime"),
        CategoryRoute(kind: "videos", title: "Videos"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                KiwiMark(size: 30)
                Text(title)
                    .font(.title2.weight(.bold))
                Spacer()
                ProfileMenu()
            }
            .padding(.horizontal, Theme.pageInset)

            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(categories, id: \.self) { category in
                        NavigationLink(value: category) {
                            Text(category.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 9)
                                .glassEffect(.regular.interactive(), in: .capsule)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, Theme.pageInset)
            }
            .scrollIndicators(.hidden)
        }
        .padding(.top, 6)
    }
}

/// Kiwi's "k" brand mark.
struct KiwiMark: View {
    var size: CGFloat = 28

    var body: some View {
        Text("k")
            .font(.system(size: size * 1.05, weight: .black, design: .rounded))
            .foregroundStyle(Theme.accent)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The featured title as a tall card with its logo, genres, Play and My List.
struct HeroCard: View {
    let item: FeaturedItem

    @Environment(AppModel.self) private var app
    @Environment(\.openItem) private var openItem
    @State private var inList: Bool?

    var body: some View {
        Color.clear
            .aspectRatio(4 / 5, contentMode: .fit)
            .overlay {
                RemoteImage(path: item.backdrop?.replacingOccurrences(of: "/w1280/", with: "/original/") ?? item.backdrop)
            }
            .overlay {
                LinearGradient(colors: [.clear, .clear, .black.opacity(0.92)], startPoint: .top, endPoint: .bottom)
            }
            .overlay(alignment: .bottom) {
                VStack(spacing: 12) {
                    TitleTreatment(title: item.title, logo: item.logo, maxWidth: 250, maxHeight: 96, fontSize: 36, textMaxWidth: 300)
                    if let genres = item.genres, !genres.isEmpty {
                        Text(genres.prefix(3).joined(separator: " • "))
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.white.opacity(0.85))
                    }
                    HStack(spacing: 10) {
                        Button {
                            if let play = item.play {
                                app.play(play.id)
                            } else {
                                Task { await app.playTitle(item.titleId ?? item.ref) }
                            }
                        } label: {
                            Label(item.play?.resume == true ? "Resume" : "Play", systemImage: "play.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .primaryAction()

                        Button {
                            Task { await toggleList() }
                        } label: {
                            Label("My List", systemImage: (inList ?? item.inLibrary ?? false) ? "checkmark" : "plus")
                                .contentTransition(.symbolEffect(.replace))
                                .frame(maxWidth: .infinity)
                        }
                        .secondaryAction()
                        .disabled(item.titleId == nil)
                    }
                }
                .padding(16)
            }
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(.white.opacity(0.18)))
            .shadow(color: .black.opacity(0.55), radius: 24, y: 12)
            .contentShape(Rectangle())
            .onTapGesture { openItem(TileItem(featured: item)) }
            .sensoryFeedback(.success, trigger: inList)
    }

    private func toggleList() async {
        guard let id = item.titleId else { return }
        let target = !(inList ?? item.inLibrary ?? false)
        inList = target
        if let updated = try? await app.api.setInWatchList(titleId: id, target) {
            inList = updated.inLibrary ?? target
        } else {
            inList = !target
        }
    }
}

/// The current profile's avatar; opens profile switching and server settings.
struct ProfileMenu: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let profile = app.currentProfile {
            Menu {
                Section(profile.name) {
                    Button("Switch Profile", systemImage: "person.2") {
                        Task { await app.switchProfile() }
                    }
                    Button("Change Server", systemImage: "server.rack") {
                        app.changeServer()
                    }
                }
            } label: {
                ProfileAvatar(profile: profile, size: 32)
            }
            .accessibilityLabel("Profile")
        }
    }
}
