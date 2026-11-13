import Foundation

// Shapes returned by the Kiwi API (apps/server). Catalog/title objects use camelCase keys; raw asset rows use
// snake_case. Everything optional that the server can leave out is optional here, so a new or missing field
// never breaks decoding.

// MARK: - Profiles

struct Profile: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let avatar: String?
    let color: String?
    let locked: Bool
    let isAdmin: Bool
    let maxRating: String?
}

struct ProfilesResponse: Decodable {
    let profiles: [Profile]
    let current: String?
}

struct SessionResponse: Decodable {
    let profile: Profile
}

struct ProfileEnvelope: Decodable {
    let profile: Profile
}

// MARK: - Catalog

/// A TMDB-backed card from `/catalog/*`, `/titles/:id/similar` and catalog search.
struct CatalogCard: Decodable, Hashable {
    let ref: String
    let titleId: String?
    let type: String
    let title: String
    let year: Int?
    let rating: Double?
    let overview: String?
    let poster: String?
    let backdrop: String?
    let isAnime: Bool?
    let inLibrary: Bool?
}

struct Rail: Decodable {
    let id: String
    let title: String
    let items: [CatalogCard]
}

struct RailsResponse: Decodable {
    let rails: [Rail]
}

struct CatalogPage: Decodable {
    let page: Int?
    let totalPages: Int?
    let items: [CatalogCard]
}

struct Genre: Decodable, Hashable {
    let id: Int
    let name: String
}

struct PlayTarget: Decodable, Hashable {
    let id: String
    let resume: Bool?
    let season: Int?
    let episode: Int?
}

struct FeaturedItem: Decodable, Hashable, Identifiable {
    let ref: String
    let titleId: String?
    let type: String
    let title: String
    let year: Int?
    let overview: String?
    let rating: Double?
    let backdrop: String?
    let logo: String?
    let genres: [String]?
    let isAnime: Bool?
    let inLibrary: Bool?
    let runtimeMin: Int?
    let certification: String?
    let play: PlayTarget?

    var id: String { ref }
}

struct FeaturedResponse: Decodable {
    let items: [FeaturedItem]
}

// MARK: - Titles

struct Season: Decodable, Hashable, Identifiable {
    let number: Int
    let name: String?
    let overview: String?
    let poster: String?
    let episodeCount: Int?

    var id: Int { number }
}

struct CastMember: Decodable, Hashable {
    let name: String
    let character: String?
    let profile: String?
}

/// An episode, or a movie's single playable asset (`assetSummary` on the server).
struct Episode: Decodable, Hashable, Identifiable {
    let id: String
    let title: String?
    let description: String?
    let season: Int?
    let episode: Int?
    let durationMs: Int?
    let thumbnail: String?
    let availability: String?
    let titleId: String?
    let progressMs: Int?
    let watched: Bool?
    let resume: Bool?

    var progressFraction: Double? {
        guard let progressMs, let durationMs, durationMs > 0, progressMs > 0, watched != true else { return nil }
        return min(1, Double(progressMs) / Double(durationMs))
    }

    var episodeLabel: String? {
        guard let season, let episode else { return nil }
        return season == 0 ? "Special \(episode)" : "S\(season):E\(episode)"
    }
}

/// `publicTitle` plus whatever the endpoint adds (`/titles`, `/titles/:ref`, `/continue`).
struct Title: Decodable, Hashable, Identifiable {
    let id: String
    let type: String
    let isAnime: Bool?
    let title: String
    let year: Int?
    let overview: String?
    let tagline: String?
    let runtimeMin: Int?
    let rating: Double?
    let certification: String?
    let genres: [String]?
    let poster: String?
    let posterLarge: String?
    let backdrop: String?
    let backdropSmall: String?
    let logo: String?
    let cast: [CastMember]?
    let inLibrary: Bool?
    let ref: String?
    let seasons: [Season]?
    let nextUp: Episode?
    let episodeCount: Int?

    var isShow: Bool { type == "show" }
}

struct ContinueItem: Decodable, Hashable {
    let title: Title
    let asset: Episode
    let resume: Bool?
}

struct EpisodesResponse: Decodable {
    let season: Int?
    let episodes: [Episode]
}

struct SimilarResponse: Decodable {
    let items: [CatalogCard]
}

// MARK: - Library assets (snake_case rows)

struct Topic: Decodable, Hashable, Identifiable {
    let id: String
    let slug: String
    let name: String
    let itemCount: Int?

    enum CodingKeys: String, CodingKey {
        case id, slug, name
        case itemCount = "item_count"
    }
}

struct CatalogLink: Decodable, Hashable {
    struct Neighbor: Decodable, Hashable {
        let id: String
        let title: String?
        let season: Int?
        let episode: Int?
    }

    let titleId: String?
    let type: String?
    let title: String?
    let season: Int?
    let episode: Int?
    let poster: String?
    let backdrop: String?
    let next: Neighbor?
}

/// A raw asset row from `/assets`, `/assets/:id` and local search.
struct Asset: Decodable, Hashable, Identifiable {
    let id: String
    let kind: String?
    let title: String?
    let description: String?
    let thumbnailURL: String?
    let durationMs: Int?
    let titleId: String?
    let progressMs: Int?
    let completed: Bool
    let catalog: CatalogLink?
    let filePath: String?
    let saved: Bool
    let myLikes: Int
    let likeCount: Int
    let viewCount: Int
    let topics: [Topic]

    enum CodingKeys: String, CodingKey {
        case id, kind, title, description, catalog, completed, saved, topics
        case thumbnailURL = "thumbnail_url"
        case durationMs = "duration_ms"
        case titleId = "title_id"
        case progressMs = "progress_ms"
        case filePath = "file_path"
        case myLikes = "my_likes"
        case likeCount = "like_count"
        case viewCount = "view_count"
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        thumbnailURL = try c.decodeIfPresent(String.self, forKey: .thumbnailURL)
        durationMs = try c.decodeLossyIntIfPresent(forKey: .durationMs)
        titleId = try c.decodeIfPresent(String.self, forKey: .titleId)
        progressMs = try c.decodeLossyIntIfPresent(forKey: .progressMs)
        completed = c.decodeLossyBool(forKey: .completed)
        catalog = try c.decodeIfPresent(CatalogLink.self, forKey: .catalog)
        filePath = try? c.decodeIfPresent(String.self, forKey: .filePath)
        saved = c.decodeLossyBool(forKey: .saved)
        myLikes = (try? c.decodeLossyIntIfPresent(forKey: .myLikes)) ?? 0
        likeCount = (try? c.decodeLossyIntIfPresent(forKey: .likeCount)) ?? 0
        viewCount = (try? c.decodeLossyIntIfPresent(forKey: .viewCount)) ?? 0
        topics = (try? c.decodeIfPresent([Topic].self, forKey: .topics)) ?? []
    }

    /// A readable name: library files are often titled by their filename.
    var displayTitle: String {
        let raw = title?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !raw.isEmpty else { return "Untitled" }
        let ext = (raw as NSString).pathExtension.lowercased()
        return ["mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "ts"].contains(ext)
            ? (raw as NSString).deletingPathExtension
            : raw
    }

    var progressFraction: Double? {
        guard !completed, let progressMs, let durationMs, durationMs > 0, progressMs > 0 else { return nil }
        return min(1, Double(progressMs) / Double(durationMs))
    }
}

// MARK: - Search

struct SearchTitle: Decodable, Hashable {
    let id: String
    let ref: String?
    let type: String
    let title: String
    let year: Int?
    let overview: String?
    let poster: String?
}

enum SearchResult: Decodable, Hashable {
    case title(SearchTitle)
    case asset(Asset)
    case other

    private enum Keys: String, CodingKey { case entityType }

    init(from decoder: any Decoder) throws {
        let kind = try decoder.container(keyedBy: Keys.self).decodeIfPresent(String.self, forKey: .entityType)
        switch kind {
        case "title": self = .title(try SearchTitle(from: decoder))
        case "asset": self = .asset(try Asset(from: decoder))
        default: self = .other
        }
    }
}

// MARK: - Playback

struct StreamInfo: Decodable {
    struct Video: Decodable { let codec: String? }
    struct Plan: Decodable {
        let mode: String?
        let audioPosition: Int?
        let video: String?
    }
    struct AudioTrack: Decodable, Hashable {
        let position: Int
        let language: String?
        let codec: String?
        let `default`: Bool?
        let label: String?
    }
    struct Chosen: Decodable { let audioPosition: Int? }

    let status: String?
    let stage: String?
    let origin: String?
    let durationMs: Int?
    let container: String?
    let video: Video?
    let playback: Plan?
    let audio: [AudioTrack]?
    let chosen: Chosen?
}

// MARK: - Likes

/// Engagement counts after a like. `my_likes` is this profile's level, 0–5.
struct Engagement: Decodable {
    let myLikes: Int?
    let likeCount: Int?
    let viewCount: Int?

    enum CodingKeys: String, CodingKey {
        case myLikes = "my_likes"
        case likeCount = "like_count"
        case viewCount = "view_count"
    }
}

/// Likes are levels: each tap adds one, up to five, like the web app's like button.
enum LikeLevel {
    static let maximum = 5
    static let labels = ["Like", "Liked", "Really like", "Love it", "Love it!", "Adored"]

    static func label(_ level: Int) -> String { labels[min(max(level, 0), maximum)] }
}

// MARK: - Channels (TV Guide)

/// `GET /guide`: channels with their programs inside a time window. Times are epoch milliseconds.
struct GuideResponse: Decodable {
    let start: Double
    let end: Double
    let now: Double
    let total: Int
    let channels: [Channel]
}

struct Channel: Decodable, Hashable, Identifiable {
    let key: String
    let number: Int
    let name: String
    let type: String?
    let avatarURL: String?
    let programs: [Program]

    var id: String { key }

    enum CodingKeys: String, CodingKey {
        case key, number, name, type, programs
        case avatarURL = "avatar_url"
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        number = try c.decode(Int.self, forKey: .number)
        name = try c.decode(String.self, forKey: .name)
        type = try c.decodeIfPresent(String.self, forKey: .type)
        avatarURL = try c.decodeIfPresent(String.self, forKey: .avatarURL)
        programs = try c.decodeIfPresent([Program].self, forKey: .programs) ?? []
    }

    /// The program on air at `time` (ms), like the web's `airing()`.
    func airing(at time: Double) -> Program? {
        programs.first { $0.start <= time && time < $0.end }
    }

    func upNext(at time: Double) -> Program? {
        programs.first { $0.start > time }
    }
}

struct Program: Decodable, Hashable, Identifiable {
    /// The asset that plays.
    let assetId: String
    let title: String?
    let subtitle: String?
    let thumbnailURL: String?
    let durationMs: Int?
    let titleId: String?
    let catalog: Bool?
    let start: Double
    let end: Double

    /// The same asset can air twice in one window, so the start time is part of the identity.
    var id: String { "\(assetId)@\(Int(start))" }

    enum CodingKeys: String, CodingKey {
        case title, subtitle, catalog, start, end
        case assetId = "id"
        case thumbnailURL = "thumbnail_url"
        case durationMs = "duration_ms"
        case titleId = "title_id"
    }

    func progress(at time: Double) -> Double {
        guard end > start else { return 0 }
        return min(1, max(0, (time - start) / (end - start)))
    }
}

/// Wall-clock time in the server's terms, corrected by the offset seen on the last guide response.
enum GuideClock {
    static var skew: Double = 0
    static var now: Double { Date().timeIntervalSince1970 * 1000 + skew }

    static func time(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(date: .omitted, time: .shortened)
    }
}

struct StreamStart: Decodable {
    let origin: Double
}

struct HealthResponse: Decodable {
    let ok: Bool?
    let service: String?
}

// MARK: - Lossy decoding helpers

extension KeyedDecodingContainer {
    /// SQLite booleans arrive as 0/1, newer code sends true/false.
    func decodeLossyBool(forKey key: Key) -> Bool {
        if let value = try? decodeIfPresent(Bool.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value != 0 }
        return false
    }

    func decodeLossyIntIfPresent(forKey key: Key) throws -> Int? {
        if let value = try? decodeIfPresent(Int.self, forKey: key) { return value }
        if let value = try? decodeIfPresent(Double.self, forKey: key) { return Int(value) }
        return nil
    }
}
