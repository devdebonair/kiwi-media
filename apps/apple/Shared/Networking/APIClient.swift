import Foundation

enum APIError: LocalizedError, Equatable {
    case noServer
    case profileRequired
    case notFound
    case http(status: Int, message: String?, code: String?)
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .noServer: "No Kiwi server is set up."
        case .profileRequired: "Choose a profile first."
        case .notFound: "This isn't available."
        case let .http(status, message, _): message ?? "The server answered with an error (\(status))."
        case .invalidResponse: "The server sent something unexpected."
        }
    }

    var code: String? {
        if case let .http(_, _, code) = self { return code }
        return nil
    }
}

/// Talks to a Kiwi API server. The server picks the profile from the `kiwi_profile` cookie, which
/// `URLSession.shared` stores and sends on its own, so API calls, image loads and AVPlayer share one session.
@Observable
final class APIClient {
    private(set) var baseURL: URL?

    /// Called when the server says no profile is chosen (expired or signed-out cookie).
    @ObservationIgnored var onProfileRequired: (() -> Void)?

    @ObservationIgnored private let session: URLSession
    @ObservationIgnored private let decoder = JSONDecoder()

    init(baseURL: URL?, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func setBaseURL(_ url: URL?) {
        baseURL = url
    }

    // MARK: URLs and cookies

    /// Resolves a root-relative server path (`/api/v1/…`, `/generated/…`) or passes an absolute URL through.
    func url(_ path: String?) -> URL? {
        guard let path, !path.isEmpty else { return nil }
        if path.hasPrefix("http://") || path.hasPrefix("https://") { return URL(string: path) }
        guard let baseURL else { return nil }
        return URL(string: path, relativeTo: baseURL)?.absoluteURL
    }

    /// Cookies for this server, for AVPlayer (`AVURLAssetHTTPCookiesKey`).
    func cookies() -> [HTTPCookie] {
        guard let baseURL else { return [] }
        return session.configuration.httpCookieStorage?.cookies(for: baseURL) ?? []
    }

    /// Escapes an id or `tmdb:movie:603` ref for use as one path segment.
    static func segment(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    // MARK: Requests

    func get<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        let (data, _) = try await perform("GET", path, body: nil)
        return try decode(data)
    }

    @discardableResult
    func send<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil, as type: T.Type = T.self) async throws -> T {
        let (data, _) = try await perform(method, path, body: body ?? [:])
        return try decode(data)
    }

    func sendIgnoringResult(_ method: String, _ path: String, body: [String: Any]? = nil) async throws {
        _ = try await perform(method, path, body: body ?? [:])
    }

    /// Returns the raw status too, for endpoints that answer 202 while they work.
    func sendWithStatus<T: Decodable>(_ method: String, _ path: String, body: [String: Any]?, as type: T.Type = T.self) async throws -> (T, Int) {
        let (data, status) = try await perform(method, path, body: body ?? [:])
        return (try decode(data), status)
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            #if DEBUG
            print("Kiwi decode error for \(T.self): \(error)")
            #endif
            throw APIError.invalidResponse
        }
    }

    private func perform(_ method: String, _ path: String, body: [String: Any]?) async throws -> (Data, Int) {
        guard let url = url(path) else { throw APIError.noServer }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body, method != "GET" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        let status = http.statusCode
        guard (200..<300).contains(status) else {
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let message = payload?["error"] as? String
            let code = payload?["code"] as? String
            if status == 401, code == "profile_required" {
                onProfileRequired?()
                throw APIError.profileRequired
            }
            if status == 404 { throw APIError.notFound }
            throw APIError.http(status: status, message: message, code: code)
        }
        return (data, status)
    }
}

// MARK: - Endpoints

extension APIClient {
    func health() async throws -> HealthResponse { try await get("/api/v1/health") }
    func session() async throws -> Profile { try await get("/api/v1/session", as: SessionResponse.self).profile }
    func profiles() async throws -> ProfilesResponse { try await get("/api/v1/profiles") }

    func selectProfile(_ id: String, pin: String?) async throws -> Profile {
        let body: [String: Any] = pin.map { ["pin": $0] } ?? [:]
        return try await send("POST", "/api/v1/profiles/\(Self.segment(id))/select", body: body, as: ProfileEnvelope.self).profile
    }

    func signOut() async throws {
        try await sendIgnoringResult("POST", "/api/v1/session/sign-out")
    }

    func featured(kind: String) async throws -> [FeaturedItem] {
        try await get("/api/v1/catalog/featured?kind=\(kind)", as: FeaturedResponse.self).items
    }

    func continueWatching(kind: String? = nil) async throws -> [ContinueItem] {
        try await get("/api/v1/continue?limit=20" + (kind.map { "&kind=\($0)" } ?? ""))
    }

    /// The profile's Watch List titles.
    func watchList(query: String = "") async throws -> [Title] {
        let limit = query.contains("limit=") ? "" : "&limit=60"
        return try await get("/api/v1/titles?sort=added" + limit + query)
    }

    func forYou(kind: String) async throws -> [Rail] {
        try await get("/api/v1/catalog/for-you?kind=\(kind)", as: RailsResponse.self).rails
    }

    func catalogHome(kind: String) async throws -> [Rail] {
        try await get("/api/v1/catalog/home?kind=\(kind)", as: RailsResponse.self).rails
    }

    func genres(kind: String) async throws -> [Genre] {
        try await get("/api/v1/catalog/genres?kind=\(kind)")
    }

    func browse(kind: String, genre: Int, sort: String = "popular") async throws -> [CatalogCard] {
        try await get("/api/v1/catalog/browse?kind=\(kind)&genre=\(genre)&sort=\(sort)&page=1", as: CatalogPage.self).items
    }

    func catalogSearch(_ query: String) async throws -> [CatalogCard] {
        try await get("/api/v1/catalog/search?q=\(Self.query(query))&page=1", as: CatalogPage.self).items
    }

    func search(_ query: String) async throws -> [SearchResult] {
        try await get("/api/v1/search?q=\(Self.query(query))&kind=all&limit=60")
    }

    func title(_ ref: String) async throws -> Title {
        try await get("/api/v1/titles/\(Self.segment(ref))")
    }

    func episodes(titleId: String, season: Int) async throws -> [Episode] {
        try await get("/api/v1/titles/\(Self.segment(titleId))/episodes?season=\(season)", as: EpisodesResponse.self).episodes
    }

    func similar(titleId: String) async throws -> [CatalogCard] {
        try await get("/api/v1/titles/\(Self.segment(titleId))/similar", as: SimilarResponse.self).items
    }

    func setInWatchList(titleId: String, _ inLibrary: Bool) async throws -> Title {
        try await send("PUT", "/api/v1/titles/\(Self.segment(titleId))/library", body: ["inLibrary": inLibrary])
    }

    func topics() async throws -> [Topic] { try await get("/api/v1/topics") }

    func videos(topic: String? = nil, shuffleSeed: Int? = nil, limit: Int = 30) async throws -> [Asset] {
        var path = "/api/v1/assets?kind=video&limit=\(limit)"
        if let topic { path += "&topic=\(Self.query(topic))" }
        if let shuffleSeed { path += "&sort=shuffle&seed=\(shuffleSeed)" }
        return try await get(path)
    }

    /// Short library videos (under the profile's Shorts limit, 90 seconds by default), newest first.
    func shorts(limit: Int = 20, offset: Int = 0) async throws -> [Asset] {
        try await get("/api/v1/shorts?limit=\(limit)&offset=\(offset)")
    }

    func asset(_ id: String) async throws -> Asset {
        try await get("/api/v1/assets/\(Self.segment(id))")
    }

    /// Asks the server to get a stream ready. Answers 202 `{status:"preparing"}` while it is still working.
    func prepareStream(_ id: String) async throws -> (StreamInfo, Int) {
        try await sendWithStatus("POST", "/api/v1/assets/\(Self.segment(id))/stream", body: ["caps": ["hevc"]], as: StreamInfo.self)
    }

    func streamStart(_ id: String, start: Int, video: String) async throws -> StreamStart {
        try await get("/api/v1/assets/\(Self.segment(id))/stream-start?start=\(start)&video=\(video)")
    }

    func saveProgress(_ id: String, progressMs: Int, completed: Bool) async throws {
        try await sendIgnoringResult("PUT", "/api/v1/assets/\(Self.segment(id))/progress", body: ["progressMs": progressMs, "completed": completed])
    }

    /// Sets this profile's like level (0–5) on an asset.
    func setLikes(_ id: String, count: Int) async throws -> Engagement {
        try await send("PUT", "/api/v1/assets/\(Self.segment(id))/likes", body: ["count": count])
    }

    /// Videos this profile has liked, most-liked first.
    func liked(limit: Int = 40) async throws -> [Asset] {
        try await get("/api/v1/liked?limit=\(limit)")
    }

    /// Channels and their programs from `start` (ms, default now) for `hours`.
    func guide(hours: Int = 4, limit: Int = 40, offset: Int = 0, channel: String? = nil) async throws -> GuideResponse {
        var path = "/api/v1/guide?hours=\(hours)&limit=\(limit)&offset=\(offset)&start=\(Int(GuideClock.now))"
        if let channel { path += "&channel=\(Self.query(channel))" }
        let sent = Date().timeIntervalSince1970 * 1000
        let response: GuideResponse = try await get(path)
        GuideClock.skew = response.now - sent
        return response
    }

    /// Tells the server a channel is being watched so it warms its upcoming programs.
    func tune(_ channel: String) async throws {
        try await sendIgnoringResult("POST", "/api/v1/guide/tune", body: ["channel": channel])
    }

    func recordView(_ id: String, sessionId: String) async throws {
        try await sendIgnoringResult("POST", "/api/v1/assets/\(Self.segment(id))/views", body: ["sessionId": sessionId])
    }

    private static func query(_ value: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+?#")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
