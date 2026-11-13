import SwiftUI

/// The signed-in app, laid out like Netflix's 2026 iPhone app: Home, Clips (a vertical feed), Live, the
/// profile's own space, and Search — each tab with its own navigation stack.
struct MainView: View {
    let profile: Profile

    @Environment(AppModel.self) private var app

    var body: some View {
        TabView {
            Tab("Home", systemImage: "house.fill") {
                TabSection {
                    BrowseScreen(
                        title: "Home",
                        isHome: true,
                        emptyMessage: "Add a library folder or a few titles to your list from the web app.",
                        model: BrowseModel(load: Feeds.home)
                    )
                }
            }
            Tab("Clips", systemImage: "play.square.stack.fill") {
                TabSection { ClipsScreen() }
            }
            Tab("Live", systemImage: "dot.radiowaves.left.and.right") {
                TabSection { LiveScreen() }
            }
            Tab(profile.name, systemImage: "person.crop.circle.fill") {
                TabSection { MyKiwiScreen(profile: profile) }
            }
            Tab(role: .search) {
                TabSection { SearchScreen() }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .onChange(of: app.playRequest) { _, request in
            guard let request else { return }
            PlayerPresenter.shared.present(request, api: app.api) {
                app.playRequest = nil
                app.playerClosed()
            }
        }
    }
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
