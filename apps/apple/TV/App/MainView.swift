import SwiftUI

/// The signed-in app: a top navigation bar of sections (as in Netflix's 2025 TV redesign), each with its own
/// navigation stack.
///
/// The profile tab's Switch Profile opens a quick switcher over the page, like the menu under Netflix's profile
/// icon; a locked profile asks for its PIN on the way.
///
/// Channels always play through the Live tab's player (tuning from another tab switches to Live), so going
/// back from full screen lands on the guide with the channel still playing. Everything else plays full screen
/// in the VLC player.
struct MainView: View {
    let profile: Profile

    @Environment(AppModel.self) private var app
    @State private var tab = "home"
    @State private var live = LivePlayer()
    @State private var switcherOpen = false
    /// A locked profile picked in the switcher, waiting for its PIN.
    @State private var pinProfile: Profile?

    /// Asset requests only; channel requests go to the Live tab's player instead.
    private var assetRequest: Binding<PlayRequest?> {
        Binding {
            if case .asset = app.playRequest?.source { app.playRequest } else { nil }
        } set: {
            app.playRequest = $0
        }
    }

    var body: some View {
        @Bindable var live = live
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
            // The profile's own space, like "My Netflix": account actions, then Continue Watching, Liked, My List.
            Tab(value: "me") {
                TabSection {
                    BrowseScreen(
                        emptyMessage: "Titles you add to My List and videos you like show up here.",
                        model: BrowseModel(load: Feeds.myList),
                        header: AnyView(AccountBar(profile: profile, switcherOpen: $switcherOpen))
                    )
                }
            } label: {
                Text(profile.name)
            }
        }
        // While the switcher is open, focus stays in it.
        .disabled(switcherOpen)
        .overlay(alignment: .topTrailing) {
            if switcherOpen {
                ZStack(alignment: .topTrailing) {
                    Color.black.opacity(0.5).ignoresSafeArea()
                    ProfileSwitcher(current: profile) { locked in
                        switcherOpen = false
                        pinProfile = locked
                    } onClose: {
                        switcherOpen = false
                    }
                    .padding(.top, 110)
                    .padding(.trailing, Theme.pageInset)
                }
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: switcherOpen)
        // A right PIN switches profiles, which replaces this whole view; Back returns to the switcher.
        .fullScreenCover(item: $pinProfile, onDismiss: { switcherOpen = true }) { profile in
            PinEntryView(profile: profile)
        }
        .environment(live)
        .fullScreenCover(item: assetRequest, onDismiss: app.playerClosed) { request in
            if case let .asset(id, startOver) = request.source {
                VLCPlayerScreen(api: app.api, assetId: id, startOver: startOver)
            }
        }
        .fullScreenCover(isPresented: $live.isFullscreen) {
            if let session = live.session {
                LivePlayerScreen(session: session)
            }
        }
        .onChange(of: app.playRequest) { _, request in
            guard let request else { return }
            if case let .channel(key) = request.source {
                app.playRequest = nil
                tab = "live"
                live.tune(key, api: app.api)
                live.isFullscreen = true
            } else {
                live.stop()
            }
        }
        .onChange(of: tab) { _, tab in
            // Live plays on its own tab only.
            if tab != "live" { live.stop() }
        }
        .onDisappear { live.stop() }
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
    @Binding var switcherOpen: Bool

    @Environment(AppModel.self) private var app
    @FocusState private var switchFocused: Bool

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
                switcherOpen = true
            } label: {
                Label("Switch Profile", systemImage: "person.2")
            }
            .secondaryAction()
            .focused($switchFocused)
            Button {
                app.changeServer()
            } label: {
                Label("Change Server", systemImage: "server.rack")
            }
            .secondaryAction()
        }
        .focusSection()
        // Back where it was when the switcher closes without switching.
        .onChange(of: switcherOpen) { _, open in
            if !open { switchFocused = true }
        }
    }
}
