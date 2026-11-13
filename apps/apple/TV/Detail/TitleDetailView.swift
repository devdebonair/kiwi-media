import SwiftUI


struct TitleDetailView: View {
    @State private var model: TitleDetailModel

    @Environment(AppModel.self) private var app
    @Environment(\.openItem) private var openItem
    @FocusState private var focusKey: String?

    init(ref: String) {
        _model = State(initialValue: TitleDetailModel(ref: ref))
    }

    var body: some View {
        ZStack {
            switch model.state {
            case .loading:
                ProgressView().controlSize(.large)
            case let .failed(message):
                ContentUnavailableView("Couldn't open this title", systemImage: "exclamationmark.triangle", description: Text(message))
            case .loaded:
                if let title = model.title { content(title) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            BackdropView(path: model.title?.backdrop)
        }
        .toolbar(.hidden, for: .navigationBar)
        .task { await model.load(app.api) }
        .onChange(of: app.playbackGeneration) {
            Task { await model.load(app.api) }
        }
    }

    private func content(_ title: Title) -> some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 48) {
                header(title)
                    .focusSection()
                if title.isShow { seasonsSection(title) }
                if !model.similar.isEmpty {
                    ShelfView(
                        shelf: Shelf(id: "similar", title: "More Like This", style: .poster, items: model.similar.map(TileItem.init(card:))),
                        focus: $focusKey
                    )
                }
                if let cast = title.cast, !cast.isEmpty {
                    castSection(cast)
                }
            }
            .padding(.bottom, 80)
        }
        .scrollClipDisabled()
    }

    // MARK: Header

    private func header(_ title: Title) -> some View {
        VStack(alignment: .leading, spacing: 22) {
            Spacer(minLength: 0)
            TitleTreatment(title: title.title, logo: title.logo, maxHeight: 200)
            Text(metadata(title))
                .font(.callout)
                .foregroundStyle(Theme.secondaryText)
            if let next = title.nextUp, title.isShow, let label = next.episodeLabel {
                Text([label, next.title].compactMap { $0 }.joined(separator: " · "))
                    .font(.headline)
            }
            if let overview = title.overview, !overview.isEmpty {
                Text(overview)
                    .lineLimit(4)
                    .frame(maxWidth: 1000, alignment: .leading)
            }
            if let progress = title.nextUp?.progressFraction, title.nextUp?.resume == true {
                ProgressBar(value: progress).frame(width: 420)
            }
            HStack(spacing: 24) {
                if let next = title.nextUp {
                    Button {
                        app.play(next.id)
                    } label: {
                        Label(playLabel(title, next), systemImage: "play.fill")
                    }
                    .buttonStyle(PillButtonStyle(prominent: true))

                    if next.resume == true {
                        Button {
                            app.play(next.id, startOver: true)
                        } label: {
                            Label("Start Over", systemImage: "arrow.counterclockwise")
                        }
                        .buttonStyle(PillButtonStyle())
                    }
                }
                Button {
                    Task { await model.toggleWatchList(app.api) }
                } label: {
                    Label("My List", systemImage: title.inLibrary == true ? "checkmark" : "plus")
                }
                .buttonStyle(PillButtonStyle())
                if title.nextUp != nil {
                    // Each press adds a like, up to five ("Adored"); one more press clears it.
                    Button {
                        Task { await model.like(app.api) }
                    } label: {
                        Label(LikeLevel.label(model.myLikes), systemImage: model.myLikes > 0 ? "heart.fill" : "heart")
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .buttonStyle(PillButtonStyle())
                }
            }
            .padding(.top, 8)
        }
        .frame(minHeight: 700, alignment: .bottomLeading)
    }

    private func playLabel(_ title: Title, _ next: Episode) -> String {
        let resume = next.resume == true
        if title.isShow, let label = next.episodeLabel {
            return resume ? "Resume \(label)" : "Play \(label)"
        }
        return resume ? "Resume" : "Play"
    }

    private func metadata(_ title: Title) -> String {
        var parts: [String] = []
        if let year = title.year { parts.append(String(year)) }
        if let certification = title.certification, !certification.isEmpty { parts.append(certification) }
        if title.isShow {
            let count = (title.seasons ?? []).filter { $0.number > 0 }.count
            if count > 0 { parts.append(count == 1 ? "1 Season" : "\(count) Seasons") }
        } else if let runtime = title.runtimeMin, runtime > 0 {
            parts.append(TileItem.duration(runtime * 60_000))
        }
        if let rating = title.rating, rating > 0 { parts.append(String(format: "★ %.1f", rating)) }
        if let genres = title.genres, !genres.isEmpty { parts.append(genres.prefix(3).joined(separator: ", ")) }
        return parts.joined(separator: "  ·  ")
    }

    // MARK: Seasons and episodes

    private func seasonsSection(_ title: Title) -> some View {
        let seasons = (title.seasons ?? []).sorted { ($0.number == 0 ? Int.max : $0.number) < ($1.number == 0 ? Int.max : $1.number) }
        return VStack(alignment: .leading, spacing: 24) {
            if seasons.count > 1 {
                ScrollView(.horizontal) {
                    HStack(spacing: 20) {
                        ForEach(seasons) { season in
                            Button {
                                Task { await model.select(season: season.number, app.api) }
                            } label: {
                                Text(season.name ?? "Season \(season.number)")
                            }
                            .buttonStyle(SeasonButtonStyle(selected: model.selectedSeason == season.number))
                        }
                    }
                    .padding(.vertical, 12)
                }
                .scrollClipDisabled()
                .focusSection()
            } else {
                Text(seasons.first?.name ?? "Episodes")
                    .font(.title3.weight(.semibold))
            }

            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: Theme.shelfSpacing) {
                    ForEach(model.episodes) { episode in
                        EpisodeCard(episode: episode)
                    }
                }
                .padding(.vertical, 24)
            }
            .scrollClipDisabled()
            .focusSection()
        }
    }

    private func castSection(_ cast: [CastMember]) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Cast")
                .font(.title3.weight(.semibold))
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 36) {
                    ForEach(cast.prefix(15), id: \.self) { member in
                        VStack(spacing: 10) {
                            RemoteImage(path: member.profile)
                                .frame(width: 150, height: 150)
                                .background(Theme.placeholder)
                                .clipShape(Circle())
                            Text(member.name)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                            if let character = member.character, !character.isEmpty {
                                Text(character)
                                    .font(.caption2)
                                    .foregroundStyle(Theme.secondaryText)
                                    .lineLimit(1)
                            }
                        }
                        .frame(width: 180)
                    }
                }
            }
            .scrollClipDisabled()
        }
    }
}

struct EpisodeCard: View {
    let episode: Episode

    @Environment(AppModel.self) private var app
    @FocusState private var isFocused: Bool

    private var unaired: Bool { episode.availability == "unaired" }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button {
                app.play(episode.id)
            } label: {
                ZStack(alignment: .bottomLeading) {
                    Theme.placeholder
                    RemoteImage(path: episode.thumbnail)
                    if let progress = episode.progressFraction {
                        ProgressBar(value: progress)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 14)
                    }
                    if episode.watched == true {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(.white, Theme.accent)
                            .padding(14)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    }
                }
                .frame(width: Theme.landscapeSize.width, height: Theme.landscapeSize.height)
            }
            .buttonStyle(.card)
            .disabled(unaired)
            .focused($isFocused)

            VStack(alignment: .leading, spacing: 6) {
                Text([episode.episode.map { "\($0)." }, episode.title].compactMap { $0 }.joined(separator: " "))
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)
                Text(unaired ? "Coming soon" : (episode.durationMs.map(TileItem.duration) ?? ""))
                    .font(.caption)
                    .foregroundStyle(Theme.secondaryText)
                if isFocused, let description = episode.description, !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(Theme.secondaryText)
                        .lineLimit(3)
                }
            }
            .frame(width: Theme.landscapeSize.width, alignment: .leading)
            .offset(y: isFocused ? 10 : 0)
            .animation(.easeOut(duration: 0.2), value: isFocused)
        }
        .opacity(unaired ? 0.5 : 1)
    }
}

struct SeasonButtonStyle: ButtonStyle {
    let selected: Bool

    func makeBody(configuration: Configuration) -> some View {
        SeasonBody(configuration: configuration, selected: selected)
    }

    private struct SeasonBody: View {
        let configuration: ButtonStyleConfiguration
        let selected: Bool
        @Environment(\.isFocused) private var isFocused

        var body: some View {
            configuration.label
                .font(.callout.weight(selected ? .bold : .medium))
                .padding(.horizontal, 28)
                .padding(.vertical, 14)
                .foregroundStyle(isFocused ? Color.black : (selected ? Color.white : Theme.secondaryText))
                .background(Capsule().fill(isFocused ? Color.white : (selected ? Color.white.opacity(0.22) : Color.clear)))
                .scaleEffect(isFocused ? 1.06 : 1)
                .animation(.easeOut(duration: 0.18), value: isFocused)
        }
    }
}
