import Foundation

/// One card on a shelf, whatever API object it came from.
struct TileItem: Identifiable, Hashable {
    enum Action: Hashable {
        /// Open a title page. `ref` is a local id or `tmdb:movie:603`.
        case title(ref: String)
        /// Start playing an asset straight away.
        case play(assetId: String)
        /// Join a channel live.
        case tune(channel: String)
    }

    let id: String
    let title: String
    var subtitle: String?
    var overview: String?
    /// Artwork shown on the card itself.
    var artwork: String?
    /// Wide artwork for the page background (and the TV billboard) while the card has focus.
    var backdrop: String?
    var progress: Double?
    /// Title logo artwork, shown instead of the name in billboards.
    var logo: String?
    /// "2019 · TV-MA · Drama, Crime" under the billboard title.
    var metadata: String?
    /// The title page this card belongs to, for More Info on cards that play directly (episodes, channels).
    var detailRef: String?
    /// A shortcut that plays this card from a billboard (a featured title's resume point).
    var playAssetId: String?
    let action: Action
}

struct Shelf: Identifiable, Hashable {
    enum Style: Hashable {
        case poster
        case landscape
        /// Posters with big rank numbers beside them, for a Top 10 row.
        case ranked
    }

    let id: String
    let title: String
    let style: Style
    let items: [TileItem]
}

enum Route: Hashable {
    case title(ref: String)
}

// MARK: - Mapping API objects to tiles

extension TileItem {
    init(card: CatalogCard) {
        let kind = card.isAnime == true ? "Anime" : (card.type == "show" ? "Series" : "Movie")
        self.init(
            id: card.ref,
            title: card.title,
            subtitle: card.year.map(String.init),
            overview: card.overview,
            artwork: card.poster,
            backdrop: card.backdrop.map { $0.replacingOccurrences(of: "/w780/", with: "/w1280/") },
            metadata: [card.year.map(String.init), kind, card.rating.flatMap { $0 > 0 ? String(format: "★ %.1f", $0) : nil }]
                .compactMap { $0 }.joined(separator: "  ·  "),
            detailRef: card.titleId ?? card.ref,
            action: .title(ref: card.titleId ?? card.ref)
        )
    }

    init(title: Title) {
        self.init(
            id: title.id,
            title: title.title,
            subtitle: title.year.map(String.init),
            overview: title.overview,
            artwork: title.poster,
            backdrop: title.backdrop,
            progress: title.nextUp?.progressFraction,
            logo: title.logo,
            metadata: title.metadataLine,
            detailRef: title.id,
            action: .title(ref: title.id)
        )
    }

    init(featured: FeaturedItem) {
        self.init(
            id: featured.ref,
            title: featured.title,
            subtitle: featured.year.map(String.init),
            overview: featured.overview,
            artwork: featured.backdrop,
            backdrop: featured.backdrop,
            logo: featured.logo,
            metadata: featured.metadataLine,
            detailRef: featured.titleId ?? featured.ref,
            playAssetId: featured.play?.id,
            action: .title(ref: featured.titleId ?? featured.ref)
        )
    }

    init(continuing item: ContinueItem) {
        let episode = item.asset
        let isShow = item.title.isShow
        let label = isShow ? [episode.episodeLabel, episode.title].compactMap { $0 }.joined(separator: " · ") : nil
        let remaining = episode.durationMs.map { duration in
            TileItem.duration(max(60_000, duration - (episode.progressMs ?? 0))) + " left"
        }
        self.init(
            id: "continue-\(episode.id)",
            title: item.title.title,
            subtitle: label?.isEmpty == false ? label : remaining,
            overview: isShow ? (episode.description ?? item.title.overview) : item.title.overview,
            artwork: isShow ? (episode.thumbnail ?? item.title.backdropSmall) : (item.title.backdropSmall ?? episode.thumbnail),
            backdrop: item.title.backdrop,
            progress: episode.progressFraction,
            logo: item.title.logo,
            metadata: [label?.isEmpty == false ? label : nil, remaining].compactMap { $0 }.joined(separator: "  ·  "),
            detailRef: item.title.id,
            playAssetId: episode.id,
            action: .play(assetId: episode.id)
        )
    }

    /// A library video, or a liked movie or episode.
    init(video: Asset) {
        let catalog = video.catalog
        let episodeLabel = catalog.flatMap { link in link.season.flatMap { season in link.episode.map { "S\(season):E\($0)" } } }
        let title = catalog?.title ?? video.displayTitle
        let subtitle = catalog?.type == "show"
            ? [episodeLabel, video.title].compactMap { $0 }.joined(separator: " · ")
            : video.durationMs.map(Self.duration)
        var facts: [String] = []
        if let duration = video.durationMs { facts.append(Self.duration(duration)) }
        if video.myLikes > 0 { facts.append("♥ \(LikeLevel.label(video.myLikes))") }
        if let topic = video.topics.first?.name { facts.append(topic) }
        self.init(
            id: video.id,
            title: title,
            subtitle: subtitle,
            overview: video.description,
            artwork: video.thumbnailURL ?? catalog?.backdrop ?? catalog?.poster,
            backdrop: catalog?.backdrop ?? video.thumbnailURL,
            progress: video.progressFraction,
            metadata: facts.joined(separator: "  ·  "),
            detailRef: catalog?.titleId,
            playAssetId: video.id,
            action: .play(assetId: video.id)
        )
    }

    /// What's airing now on a channel.
    init(channel: Channel, program: Program, now: Double) {
        let label = "\(channel.number)  \(channel.name)"
        self.init(
            id: "live-\(channel.key)",
            title: program.title ?? channel.name,
            subtitle: "\(label) · until \(GuideClock.time(program.end))",
            overview: program.subtitle,
            artwork: program.thumbnailURL ?? channel.avatarURL,
            backdrop: program.thumbnailURL,
            progress: program.progress(at: now),
            metadata: ["Live on \(label)", program.subtitle].compactMap { $0 }.joined(separator: "  ·  "),
            detailRef: program.titleId,
            action: .tune(channel: channel.key)
        )
    }

    init(searchTitle: SearchTitle) {
        self.init(
            id: "search-\(searchTitle.id)",
            title: searchTitle.title,
            subtitle: searchTitle.year.map(String.init),
            overview: searchTitle.overview,
            artwork: searchTitle.poster,
            detailRef: searchTitle.ref ?? searchTitle.id,
            action: .title(ref: searchTitle.ref ?? searchTitle.id)
        )
    }

    static func duration(_ ms: Int) -> String {
        let minutes = ms / 60_000
        if minutes >= 60 { return "\(minutes / 60)h \(minutes % 60)m" }
        if minutes >= 1 { return "\(minutes)m" }
        return "\(max(1, ms / 1000))s"
    }
}

extension FeaturedItem {
    var metadataLine: String {
        var parts: [String] = []
        if let year { parts.append(String(year)) }
        if let certification, !certification.isEmpty { parts.append(certification) }
        if let runtimeMin, runtimeMin > 0 {
            parts.append(type == "show" ? "\(runtimeMin)m episodes" : TileItem.duration(runtimeMin * 60_000))
        }
        if let genres, !genres.isEmpty { parts.append(genres.prefix(3).joined(separator: ", ")) }
        return parts.joined(separator: "  ·  ")
    }
}

extension Title {
    var metadataLine: String {
        var parts: [String] = []
        if let year { parts.append(String(year)) }
        if let certification, !certification.isEmpty { parts.append(certification) }
        if isShow {
            let count = (seasons ?? []).filter { $0.number > 0 }.count
            if count > 0 { parts.append(count == 1 ? "1 Season" : "\(count) Seasons") }
        } else if let runtimeMin, runtimeMin > 0 {
            parts.append(TileItem.duration(runtimeMin * 60_000))
        }
        if let genres, !genres.isEmpty { parts.append(genres.prefix(3).joined(separator: ", ")) }
        return parts.joined(separator: "  ·  ")
    }
}
