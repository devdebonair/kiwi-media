import Foundation
import Testing
@testable import Kiwi

@MainActor
struct PlaybackPlannerTests {
    private func info(_ json: String) throws -> StreamInfo {
        try JSONDecoder().decode(StreamInfo.self, from: Data(json.utf8))
    }

    @Test func mp4WithH264AndAACPlaysDirectly() throws {
        let stream = try info("""
        {"status":"ready","container":"mov,mp4,m4a,3gp,3g2,mj2","video":{"codec":"h264"},
         "playback":{"mode":"direct","audioPosition":0,"video":"copy"},
         "audio":[{"position":0,"codec":"aac","default":true}]}
        """)
        let plan = PlaybackPlanner.plan(info: stream, assetId: "abc", startSeconds: 125.7)
        #expect(plan == .init(kind: .direct, path: "/api/v1/assets/abc/file", start: 125, video: "copy"))
    }

    @Test func matroskaIsRepackagedAsHLSFromTheResumePoint() throws {
        let stream = try info("""
        {"status":"ready","container":"matroska,webm","video":{"codec":"h264"},
         "playback":{"mode":"direct","audioPosition":0,"video":"copy"},
         "audio":[{"position":0,"codec":"aac","default":true}]}
        """)
        let plan = PlaybackPlanner.plan(info: stream, assetId: "t1-s01e02", startSeconds: 61.9)
        #expect(plan.kind == .hls)
        #expect(plan.path == "/api/v1/assets/t1-s01e02/file?remux=1&hls=1&audio=0&video=copy&start=61")
    }

    @Test func hevcIsCopiedWithTheHvc1Tag() throws {
        let stream = try info("""
        {"status":"ready","container":"mov,mp4,m4a,3gp,3g2,mj2","video":{"codec":"hevc"},
         "playback":{"mode":"direct","audioPosition":1,"video":"copy"},
         "audio":[{"position":1,"codec":"eac3","default":true}]}
        """)
        let plan = PlaybackPlanner.plan(info: stream, assetId: "x", startSeconds: 0)
        #expect(plan.path == "/api/v1/assets/x/file?remux=1&hls=1&audio=1&video=copy&codec=hevc&start=0")
    }

    @Test func unsupportedVideoIsTranscoded() throws {
        let stream = try info("""
        {"status":"ready","container":"matroska,webm","video":{"codec":"vp9"},
         "playback":{"mode":"direct","audioPosition":0,"video":"copy"},
         "audio":[{"position":0,"codec":"opus","default":true}]}
        """)
        let plan = PlaybackPlanner.plan(info: stream, assetId: "x", startSeconds: 0)
        #expect(plan.video == "transcode")
        #expect(!plan.path.contains("codec=hevc"))
    }

    @Test func aNonDefaultAudioTrackForcesARepackage() throws {
        let stream = try info("""
        {"status":"ready","container":"mov,mp4,m4a,3gp,3g2,mj2","video":{"codec":"h264"},
         "playback":{"mode":"remux","audioPosition":2,"video":"copy"},
         "audio":[{"position":1,"codec":"aac","default":true},{"position":2,"codec":"aac","default":false}]}
        """)
        let plan = PlaybackPlanner.plan(info: stream, assetId: "x", startSeconds: 0)
        #expect(plan.kind == .hls)
        #expect(plan.path.contains("audio=2"))
    }

    @Test func dolbyAudioInMP4StillPlaysDirectly() throws {
        let stream = try info("""
        {"status":"ready","container":"mov,mp4,m4a,3gp,3g2,mj2","video":{"codec":"h264"},
         "playback":{"mode":"remux","audioPosition":0,"video":"copy"},
         "audio":[{"position":0,"codec":"eac3","default":false}]}
        """)
        #expect(PlaybackPlanner.plan(info: stream, assetId: "x", startSeconds: 0).kind == .direct)
    }

    @Test func refsAreEscapedAsOnePathSegment() {
        #expect(APIClient.segment("tmdb:movie:603") == "tmdb%3Amovie%3A603")
        #expect(APIClient.segment("e3aa-s01e01") == "e3aa-s01e01")
    }
}
