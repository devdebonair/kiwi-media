import Foundation

/// What a browse screen shows: an optional billboard and a stack of shelves.
struct Feed {
    var featured: FeaturedItem?
    var shelves: [Shelf]
}

/// Builds each screen's shelves. Every request is independent: a failing one (no TMDB key, a restricted
/// profile, an empty library) drops its shelf instead of failing the screen.
enum Feeds {
    static func home(_ api: APIClient) async -> Feed {
        async let featured = try? api.featured(kind: "home")
        async let continuing = try? api.continueWatching()
        async let watchList = try? api.watchList()
        async let forYou = try? api.forYou(kind: "home")
        async let movies = try? api.catalogHome(kind: "movies")
        async let shows = try? api.catalogHome(kind: "shows")
        async let anime = try? api.catalogHome(kind: "anime")
        async let videos = try? api.videos(shuffleSeed: Int.random(in: 1...10_000))
        async let live = onNow(api)

        let featuredItems = await featured ?? []
        var shelves: [Shelf] = []
        shelves.append(shelf("continue", "Continue Watching", .landscape, (await continuing ?? []).map(TileItem.init(continuing:))))
        shelves.append(await live)
        shelves.append(shelf("watchlist", "My List", .poster, (await watchList ?? []).map(TileItem.init(title:))))
        if featuredItems.count > 1 {
            shelves.append(shelf("featured", "Featured", .landscape, featuredItems.dropFirst().map(TileItem.init(featured:))))
        }
        for rail in await forYou ?? [] {
            shelves.append(shelf("foryou-\(rail.id)", rail.title, .poster, rail.items.map(TileItem.init(card:))))
        }
        for (index, (label, rails)) in [("Movies", await movies), ("Series", await shows), ("Anime", await anime)].enumerated() {
            if let rail = rails?.first {
                // The first trending row is a Top 10 with rank numbers.
                let items = rail.items.map(TileItem.init(card:))
                shelves.append(index == 0
                    ? shelf("top-\(label)", "Top 10 \(label) Today", .ranked, Array(items.prefix(10)))
                    : shelf("trending-\(label)", "Trending \(label)", .poster, items))
            }
        }
        shelves.append(shelf("videos", "Home Videos", .landscape, (await videos ?? []).map(TileItem.init(video:))))
        return Feed(featured: featuredItems.first, shelves: shelves.filter { !$0.items.isEmpty })
    }

    /// Movies, Series or Anime. `kind` is the server's catalog kind: movies, shows or anime.
    static func catalog(_ api: APIClient, kind: String) async -> Feed {
        let watchListQuery = switch kind {
        case "movies": "&type=movie&anime=0"
        case "shows": "&type=show&anime=0"
        default: "&anime=1"
        }
        async let featured = try? api.featured(kind: kind)
        async let continuing = try? api.continueWatching(kind: kind)
        async let watchList = try? api.watchList(query: watchListQuery)
        async let trending = try? api.catalogHome(kind: kind)
        async let genres = try? api.genres(kind: kind)

        var shelves: [Shelf] = []
        shelves.append(shelf("continue", "Continue Watching", .landscape, (await continuing ?? []).map(TileItem.init(continuing:))))
        shelves.append(shelf("watchlist", "My List", .poster, (await watchList ?? []).map(TileItem.init(title:))))
        for rail in await trending ?? [] {
            shelves.append(shelf("rail-\(rail.id)", rail.title, .poster, rail.items.map(TileItem.init(card:))))
        }

        // Genre rows, requested together and kept in the server's genre order.
        let picked = Array((await genres ?? []).prefix(10))
        let genreRequests = picked.map { genre in
            Task { (genre, (try? await api.browse(kind: kind, genre: genre.id)) ?? []) }
        }
        for request in genreRequests {
            let (genre, items) = await request.value
            shelves.append(shelf("genre-\(genre.id)", genre.name, .poster, items.map(TileItem.init(card:))))
        }

        let featuredItems = await featured ?? []
        return Feed(featured: featuredItems.first, shelves: shelves.filter { !$0.items.isEmpty })
    }

    /// The profile's own things: what they're partway through, what they've liked, and their Watch List.
    static func myList(_ api: APIClient) async -> Feed {
        async let continuing = try? api.continueWatching()
        async let watchList = try? api.watchList(query: "&limit=200")
        async let liked = try? api.liked()
        let titles = await watchList ?? []
        return Feed(featured: nil, shelves: [
            shelf("continue", "Continue Watching", .landscape, (await continuing ?? []).map(TileItem.init(continuing:))),
            shelf("liked", "Liked", .landscape, (await liked ?? []).map(TileItem.init(video:))),
            shelf("movies", "Movies", .poster, titles.filter { $0.type == "movie" && $0.isAnime != true }.map(TileItem.init(title:))),
            shelf("series", "Series", .poster, titles.filter { $0.type == "show" && $0.isAnime != true }.map(TileItem.init(title:))),
            shelf("anime", "Anime", .poster, titles.filter { $0.isAnime == true }.map(TileItem.init(title:))),
        ].filter { !$0.items.isEmpty })
    }

    /// Library videos: newest, a shuffle, then the busiest topics.
    static func videos(_ api: APIClient) async -> Feed {
        async let recent = try? api.videos()
        async let shuffled = try? api.videos(shuffleSeed: Int.random(in: 1...10_000))
        async let topics = try? api.topics()

        var shelves: [Shelf] = [
            shelf("recent", "Recently Added", .landscape, (await recent ?? []).map(TileItem.init(video:))),
            shelf("shuffle", "Shuffle", .landscape, (await shuffled ?? []).map(TileItem.init(video:))),
        ]
        let busiest = (await topics ?? [])
            .filter { ($0.itemCount ?? 0) > 0 }
            .sorted { ($0.itemCount ?? 0) > ($1.itemCount ?? 0) }
            .prefix(8)
        let topicRequests = busiest.map { topic in
            Task { (topic, (try? await api.videos(topic: topic.slug)) ?? []) }
        }
        for request in topicRequests {
            let (topic, items) = await request.value
            shelves.append(shelf("topic-\(topic.id)", topic.name, .landscape, items.map(TileItem.init(video:))))
        }
        return Feed(featured: nil, shelves: shelves.filter { !$0.items.isEmpty })
    }

    /// Movies and episodes airing now, one per title, like the web's "On now" panel.
    static func onNow(_ api: APIClient, limit: Int = 12) async -> Shelf {
        guard let guide = try? await api.guide(hours: 1, limit: 60) else { return shelf("live", "On Now", .landscape, []) }
        let now = GuideClock.now
        var seen = Set<String>()
        var items: [TileItem] = []
        for channel in guide.channels {
            guard let program = channel.airing(at: now), program.catalog == true else { continue }
            guard seen.insert(program.titleId ?? program.assetId).inserted else { continue }
            items.append(TileItem(channel: channel, program: program, now: now))
            if items.count == limit { break }
        }
        return shelf("live", "On Now", .landscape, items)
    }

    private static func shelf(_ id: String, _ title: String, _ style: Shelf.Style, _ items: [TileItem]) -> Shelf {
        // The same title can show up twice in one rail (e.g. two episodes); keep the first.
        var seen = Set<String>()
        return Shelf(id: id, title: title, style: style, items: items.filter { seen.insert($0.id).inserted })
    }
}
