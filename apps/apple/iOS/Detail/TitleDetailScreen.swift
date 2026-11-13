import SwiftUI

/// A title page: artwork, Play / Resume, My List, the episode list for series, and More Like This.
struct TitleDetailScreen: View {
    @State private var model: TitleDetailModel

    @Environment(AppModel.self) private var app
    @Environment(\.openItem) private var openItem

    init(ref: String) {
        _model = State(initialValue: TitleDetailModel(ref: ref))
    }

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                ProgressView().controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .failed(message):
                ContentUnavailableView("Couldn't open this title", systemImage: "exclamationmark.triangle", description: Text(message))
            case .loaded:
                if let title = model.title { content(title) }
            }
        }
        .background(Theme.background.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(app.api) }
        .onChange(of: app.playbackGeneration) {
            Task { await model.load(app.api) }
        }
    }

    private func content(_ title: Title) -> some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                artwork(title)
                VStack(alignment: .leading, spacing: 14) {
                    TitleTreatment(title: title.title, logo: title.logo, maxWidth: 260, maxHeight: 90, fontSize: 30, textMaxWidth: 360)
                    Text(metadata(title))
                        .font(.subheadline)
                        .foregroundStyle(Theme.secondaryText)
                    playButtons(title)
                    if let next = title.nextUp, title.isShow, let label = next.episodeLabel {
                        Text([label, next.title].compactMap { $0 }.joined(separator: " · "))
                            .font(.subheadline.weight(.semibold))
                    }
                    if let overview = title.overview, !overview.isEmpty {
                        Text(overview).font(.subheadline)
                    }
                    if let cast = title.cast, !cast.isEmpty {
                        Text("Cast: " + cast.prefix(5).map(\.name).joined(separator: ", "))
                            .font(.caption)
                            .foregroundStyle(Theme.secondaryText)
                            .lineLimit(2)
                    }
                    actionRow(title)
                }
                .padding(.horizontal, Theme.pageInset)

                if title.isShow { episodesSection(title) }

                if !model.similar.isEmpty {
                    similarSection
                }
            }
            .padding(.bottom, 32)
        }
        .ignoresSafeArea(edges: .top)
    }

    // MARK: Header

    private func artwork(_ title: Title) -> some View {
        Color.clear
            .aspectRatio(16 / 10, contentMode: .fit)
            .overlay { RemoteImage(path: title.backdrop) }
            .overlay {
                LinearGradient(colors: [.black.opacity(0.4), .clear, .clear, Theme.background], startPoint: .top, endPoint: .bottom)
            }
            .clipped()
    }

    @ViewBuilder
    private func playButtons(_ title: Title) -> some View {
        if let next = title.nextUp {
            VStack(spacing: 8) {
                Button {
                    app.play(next.id)
                } label: {
                    Label(playLabel(title, next), systemImage: "play.fill")
                        .frame(maxWidth: .infinity)
                }
                .primaryAction()
                if next.resume == true {
                    if let progress = next.progressFraction {
                        ProgressBar(value: progress, height: 4)
                    }
                    Button {
                        app.play(next.id, startOver: true)
                    } label: {
                        Label("Start Over", systemImage: "arrow.counterclockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .secondaryAction()
                }
            }
        }
    }

    private func actionRow(_ title: Title) -> some View {
        HStack(spacing: 36) {
            Button {
                Task { await model.toggleWatchList(app.api) }
            } label: {
                VStack(spacing: 6) {
                    Image(systemName: title.inLibrary == true ? "checkmark" : "plus")
                        .font(.title2)
                        .contentTransition(.symbolEffect(.replace))
                    Text("My List").font(.caption)
                }
            }
            .buttonStyle(.plain)
            .sensoryFeedback(.success, trigger: title.inLibrary)

            if title.nextUp != nil {
                // Each tap adds a like, up to five ("Adored"); one more tap clears it.
                LikeButton(level: model.myLikes) {
                    Task { await model.like(app.api) }
                }
            }
        }
        .padding(.top, 4)
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
        return parts.joined(separator: " · ")
    }

    // MARK: Episodes

    private func episodesSection(_ title: Title) -> some View {
        let seasons = (title.seasons ?? []).sorted { ($0.number == 0 ? Int.max : $0.number) < ($1.number == 0 ? Int.max : $1.number) }
        let current = seasons.first { $0.number == model.selectedSeason }
        return VStack(alignment: .leading, spacing: 16) {
            if seasons.count > 1 {
                Menu {
                    ForEach(seasons) { season in
                        Button(season.name ?? "Season \(season.number)") {
                            Task { await model.select(season: season.number, app.api) }
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(current?.name ?? "Season")
                        Image(systemName: "chevron.down").font(.caption.weight(.bold))
                    }
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(.white.opacity(0.14)))
                }
                .buttonStyle(.plain)
            } else {
                Text("Episodes").font(.title3.weight(.bold))
            }
            LazyVStack(alignment: .leading, spacing: 20) {
                ForEach(model.episodes) { episode in
                    EpisodeRow(episode: episode)
                }
            }
        }
        .padding(.horizontal, Theme.pageInset)
    }

    private var similarSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("More Like This").font(.title3.weight(.bold))
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 8)], spacing: 8) {
                ForEach(model.similar, id: \.ref) { card in
                    let item = TileItem(card: card)
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
        }
        .padding(.horizontal, Theme.pageInset)
    }
}

struct EpisodeRow: View {
    let episode: Episode

    @Environment(AppModel.self) private var app

    private var unaired: Bool { episode.availability == "unaired" }

    var body: some View {
        Button {
            app.play(episode.id)
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    ZStack(alignment: .bottom) {
                        Theme.placeholder
                        RemoteImage(path: episode.thumbnail)
                        Image(systemName: "play.circle")
                            .font(.title)
                            .foregroundStyle(.white)
                            .shadow(radius: 4)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        if let progress = episode.progressFraction {
                            ProgressBar(value: progress, height: 3)
                        }
                    }
                    .frame(width: 136, height: 77)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))

                    VStack(alignment: .leading, spacing: 4) {
                        Text([episode.episode.map { "\($0)." }, episode.title].compactMap { $0 }.joined(separator: " "))
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(2)
                        Text(unaired ? "Coming soon" : (episode.durationMs.map(TileItem.duration) ?? ""))
                            .font(.caption)
                            .foregroundStyle(Theme.secondaryText)
                    }
                    Spacer(minLength: 0)
                    if episode.watched == true {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(Theme.accent)
                    }
                }
                if let description = episode.description, !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(Theme.secondaryText)
                        .lineLimit(3)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(unaired)
        .opacity(unaired ? 0.5 : 1)
    }
}
