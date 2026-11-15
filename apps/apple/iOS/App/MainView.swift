import SwiftUI

/// The signed-in app, laid out like Netflix's 2026 iPhone app: Home, Clips (a vertical feed), Live, the
/// profile's own space, and Search — each tab with its own navigation stack.
///
/// Channels always play in the Live tab's inline player (tuning from another tab switches to Live); everything
/// else plays in the modal system player.
struct MainView: View {
    let profile: Profile

    @Environment(AppModel.self) private var app
    @State private var tab: MainTab = .home
    @State private var live = LivePlayer()

    var body: some View {
        TabView(selection: $tab) {
            Tab("Home", systemImage: "house.fill", value: MainTab.home) {
                TabSection {
                    BrowseScreen(
                        title: "Home",
                        isHome: true,
                        emptyMessage: "Add a library folder or a few titles to your list from the web app.",
                        model: BrowseModel(load: Feeds.home)
                    )
                }
            }
            Tab("Clips", systemImage: "play.square.stack.fill", value: MainTab.clips) {
                TabSection { ClipsScreen() }
            }
            Tab("Live", systemImage: "dot.radiowaves.left.and.right", value: MainTab.live) {
                TabSection { LiveScreen() }
            }
            Tab(profile.name, systemImage: "person.crop.circle.fill", value: MainTab.profile) {
                TabSection { MyKiwiScreen(profile: profile) }
            }
            Tab(value: MainTab.search, role: .search) {
                TabSection { SearchScreen() }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .environment(live)
        .onChange(of: app.playRequest) { _, request in
            guard let request else { return }
            if case let .channel(key) = request.source {
                app.playRequest = nil
                tab = .live
                live.tune(key, api: app.api)
                return
            }
            live.stop()
            PlayerPresenter.shared.present(request, api: app.api) {
                app.playRequest = nil
                app.playerClosed()
            }
        }
        .onChange(of: tab) { _, tab in
            live.isOnScreen = tab == .live
            // Live keeps playing on other tabs only in Picture in Picture.
            if tab != .live, !live.isPictureInPicture { live.stop() }
        }
        .onAppear {
            live.isOnScreen = tab == .live
            live.onRestore = { tab = .live }
        }
        .onDisappear { live.stop() }
    }
}

private enum MainTab: Hashable {
    case home, clips, live, profile, search
}

/// One tab: a navigation stack whose cards open title pages, start playback, or tune in.
private struct TabSection<Content: View>: View {
    @ViewBuilder let content: Content

    @Environment(AppModel.self) private var app
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case let .title(ref): TitleDetailScreen(ref: ref)
                    }
                }
                .navigationDestination(for: CategoryRoute.self) { category in
                    if category.kind == "videos" {
                        BrowseScreen(title: category.title, emptyMessage: "No library videos are available to this profile.", model: BrowseModel(load: Feeds.videos))
                    } else {
                        BrowseScreen(
                            title: category.title,
                            emptyMessage: "\(category.title) need a TMDB key in Kiwi's settings.",
                            model: BrowseModel { await Feeds.catalog($0, kind: category.kind) }
                        )
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
