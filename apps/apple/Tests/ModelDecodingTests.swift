import Foundation
import Testing
@testable import Kiwi

/// Fixtures trimmed from real responses of the Kiwi API.
@MainActor
struct ModelDecodingTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test func profiles() throws {
        let response = try decode(ProfilesResponse.self, """
        {"profiles":[{"id":"user-local","name":"Vincent","avatar":null,"color":"#2f9e6b","locked":true,"isAdmin":true,"isOwner":true},
                     {"id":"e03b","name":"Malena","avatar":"🐧","color":"#2bb3c0","locked":false,"isAdmin":false,"isOwner":false}],
         "current":null}
        """)
        #expect(response.profiles.count == 2)
        #expect(response.profiles[0].locked)
        #expect(response.profiles[1].avatar == "🐧")
        #expect(response.current == nil)
    }

    @Test func continueWatchingBecomesAnEpisodeTile() throws {
        let items = try decode([ContinueItem].self, """
        [{"title":{"id":"t1","type":"show","title":"Bluey","year":2018,"backdrop":"/api/v1/images/tmdb/w1280/b.jpg",
                   "backdropSmall":"/api/v1/images/tmdb/w780/b.jpg","poster":"/api/v1/images/tmdb/w342/p.jpg"},
          "asset":{"id":"t1-s01e01","title":"The Magic Xylophone","season":1,"episode":1,"durationMs":443322,
                   "thumbnail":"/api/v1/images/tmdb/w300/e.jpg","availability":"ready","titleId":"t1","progressMs":13437,"watched":false},
          "resume":true,"lastViewedAt":"2026-11-01T00:00:00Z"}]
        """)
        let tile = TileItem(continuing: items[0])
        #expect(tile.action == .play(assetId: "t1-s01e01"))
        #expect(tile.subtitle == "S1:E1 · The Magic Xylophone")
        #expect(tile.artwork == "/api/v1/images/tmdb/w300/e.jpg")
        #expect(abs((tile.progress ?? 0) - 13437.0 / 443322.0) < 0.0001)
    }

    @Test func assetRowsAcceptSQLiteBooleans() throws {
        let asset = try decode(Asset.self, """
        {"id":"a1","kind":"video","title":"clip one.mp4","thumbnail_url":"/generated/a1.jpg","duration_ms":312000,
         "title_id":null,"progress_ms":60000,"completed":0,"saved":false,"topics":[]}
        """)
        #expect(asset.displayTitle == "clip one")
        #expect(!asset.completed)
        #expect(asset.progressFraction != nil)
        #expect(TileItem(video: asset).subtitle == "5m")
    }

    @Test func resumePointSkipsTheVeryStartAndEnd() throws {
        let nearEnd = try decode(Asset.self, #"{"id":"a","duration_ms":600000,"progress_ms":595000,"completed":false}"#)
        let middle = try decode(Asset.self, #"{"id":"a","duration_ms":600000,"progress_ms":300000,"completed":0}"#)
        let done = try decode(Asset.self, #"{"id":"a","duration_ms":600000,"progress_ms":300000,"completed":1}"#)
        #expect(PlayerSession.resumePoint(nearEnd, startOver: false) == 0)
        #expect(PlayerSession.resumePoint(middle, startOver: false) == 300)
        #expect(PlayerSession.resumePoint(middle, startOver: true) == 0)
        #expect(PlayerSession.resumePoint(done, startOver: false) == 0)
    }

    @Test func searchResultsSplitByEntityType() throws {
        let results = try decode([SearchResult].self, """
        [{"entityType":"title","id":"t1","ref":"t1","type":"movie","title":"Heat","year":1995,"poster":null},
         {"entityType":"asset","id":"a1","kind":"video","title":"x.mkv","title_id":null,"completed":0},
         {"entityType":"topic","id":"tp","slug":"s","name":"N"}]
        """)
        guard case let .title(title) = results[0], case let .asset(asset) = results[1], case .other = results[2] else {
            Issue.record("unexpected results \(results)")
            return
        }
        #expect(title.title == "Heat")
        #expect(asset.displayTitle == "x")
    }

    @Test func featuredItemMetadataLine() throws {
        let response = try decode(FeaturedResponse.self, """
        {"items":[{"ref":"t1","titleId":"t1","type":"show","title":"Bluey","year":2018,"genres":["Animation","Family","Kids","Comedy"],
                   "runtimeMin":7,"certification":"TV-Y","play":{"id":"t1-s01e01","resume":true,"season":1,"episode":1}}]}
        """)
        #expect(response.items[0].metadataLine == "2018  ·  TV-Y  ·  7m episodes  ·  Animation, Family, Kids")
        #expect(response.items[0].play?.id == "t1-s01e01")
    }
}
