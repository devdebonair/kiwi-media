import SwiftUI

/// The profile's own space, like Netflix's "My Netflix": who's signed in, then Continue Watching, Liked and
/// My List.
struct MyKiwiScreen: View {
    let profile: Profile

    @Environment(AppModel.self) private var app
    @State private var model = BrowseModel(load: Feeds.myList)

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 26) {
                VStack(spacing: 10) {
                    ProfileAvatar(profile: profile, size: 88)
                    Text(profile.name).font(.title2.weight(.bold))
                    Menu {
                        Button("Switch Profile", systemImage: "person.2") { Task { await app.switchProfile() } }
                        Button("Change Server", systemImage: "server.rack") { app.changeServer() }
                    } label: {
                        HStack(spacing: 4) {
                            Text(app.serverDescription).lineLimit(1)
                            Image(systemName: "chevron.down").font(.caption2.weight(.bold))
                        }
                        .font(.caption)
                        .foregroundStyle(Theme.secondaryText)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 12)

                ForEach(model.feed.shelves) { shelf in
                    ShelfRow(shelf: shelf)
                }
                if model.state == .empty {
                    ContentUnavailableView("Nothing saved yet", systemImage: "heart", description: Text("Titles you add to My List and videos you like show up here."))
                }
            }
            .padding(.bottom, 32)
        }
        .background { TintedBackground(path: model.feed.shelves.first?.items.first?.backdrop) }
        .navigationTitle("My Kiwi")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh(app.api, quietly: true) }
        .task { await model.refresh(app.api, quietly: model.state != .loading) }
        .onChange(of: app.playbackGeneration) {
            Task { await model.refresh(app.api, quietly: true) }
        }
    }
}
