import SwiftUI

/// The signed-in app: a top navigation bar of sections (as in Netflix's 2025 TV redesign), each with its own
/// navigation stack.
struct MainView: View {
    let profile: Profile

    @Environment(AppModel.self) private var app
    @State private var tab = "home"

    var body: some View {
        @Bindable var app = app
        TabView(selection: $tab) {
            Tab(value: "search", role: .search) {
                TabSection { SearchScreen() }
            }
            Tab(value: "home") {
                TabSection { BrowseScreen(emptyMessage: "Add a library folder or a few titles to your list from the web app.", model: BrowseModel(load: Feeds.home)) }
            } label: {
                Text("Home")
            }
            Tab(value: "live") {
                TabSection { GuideScreen() }
            } label: {
                Text("Live")
            }
            Tab(value: "movies") {
                TabSection { BrowseScreen(emptyMessage: "Movies need a TMDB key in Kiwi's settings.", model: BrowseModel { await Feeds.catalog($0, kind: "movies") }) }
            } label: {
                Text("Movies")
            }
            Tab(value: "series") {
                TabSection { BrowseScreen(emptyMessage: "Series need a TMDB key in Kiwi's settings.", model: BrowseModel { await Feeds.catalog($0, kind: "shows") }) }
            } label: {
                Text("Series")
            }
            Tab(value: "anime") {
                TabSection { BrowseScreen(emptyMessage: "Anime needs a TMDB key in Kiwi's settings.", model: BrowseModel { await Feeds.catalog($0, kind: "anime") }) }
            } label: {
                Text("Anime")
            }
            Tab(value: "videos") {
                TabSection { BrowseScreen(emptyMessage: "No library videos are available to this profile.", model: BrowseModel(load: Feeds.videos)) }
            } label: {
                Text("Videos")
            }
            // The profile's own space, like "My Netflix": account actions, then Continue Watching, Liked, My List.
            Tab(value: "me") {
                TabSection {
                    BrowseScreen(
                        emptyMessage: "Titles you add to My List and videos you like show up here.",
                        model: BrowseModel(load: Feeds.myList),
                        header: AnyView(AccountBar(profile: profile))
                    )
                }
            } label: {
                Text(profile.name)
            }
        }
        .fullScreenCover(item: $app.playRequest, onDismiss: app.playerClosed) { request in
            PlayerScreen(api: app.api, request: request)
        }
    }
}

/// One sidebar section: a navigation stack whose cards open title pages or start playback.
private struct TabSection<Content: View>: View {
    @ViewBuilder let content: Content

    @Environment(AppModel.self) private var app
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case let .title(ref): TitleDetailView(ref: ref)
                    }
                }
        }
        .environment(\.openItem) { item in
            switch item.action {
            case let .title(ref): path.append(Route.title(ref: ref))
            case let .play(assetId): app.play(assetId)
            case let .tune(channel): app.tune(channel)
            }
        }
    }
}

/// Who's signed in, with profile and server switching.
struct AccountBar: View {
    let profile: Profile

    @Environment(AppModel.self) private var app

    var body: some View {
        HStack(spacing: 28) {
            ProfileAvatar(profile: profile, size: 96)
            VStack(alignment: .leading, spacing: 4) {
                Text(profile.name).font(.title2.weight(.bold))
                Text(app.serverDescription)
                    .font(.caption)
                    .foregroundStyle(Theme.secondaryText)
            }
            Spacer()
            Button {
                Task { await app.switchProfile() }
            } label: {
                Label("Switch Profile", systemImage: "person.2")
            }
            .secondaryAction()
            Button {
                app.changeServer()
            } label: {
                Label("Change Server", systemImage: "server.rack")
            }
            .secondaryAction()
        }
        .focusSection()
    }
}
