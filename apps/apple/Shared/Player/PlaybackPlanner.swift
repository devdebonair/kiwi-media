import Foundation

/// Decides how AVPlayer should get an asset: the original bytes, or an HLS repackage made by the server.
/// Mirrors `apps/web/src/playback-plan.mjs` for Apple clients, with tvOS's own codec support.
enum PlaybackPlanner {
    struct Plan: Equatable {
        enum Kind: Equatable { case direct, hls }
        let kind: Kind
        /// Root-relative URL path with query.
        let path: String
        /// Where in the movie the stream starts (HLS) or where to seek to (direct), in whole seconds.
        let start: Int
        let video: String
    }

    /// Audio AVPlayer decodes from an MP4/MOV file on its own.
    static let nativeAudio: Set<String> = ["aac", "mp3", "ac3", "eac3", "alac", "flac"]

    static func plan(info: StreamInfo, assetId: String, startSeconds: Double) -> Plan {
        let start = max(0, Int(startSeconds.rounded(.down)))
        let file = "/api/v1/assets/\(APIClient.segment(assetId))/file"

        let container = info.container?.lowercased() ?? ""
        let nativeContainer = container.isEmpty || container.contains("mp4") || container.contains("mov")
        let videoCodec = info.video?.codec?.lowercased()
        // HLS can carry H.264 and HEVC untouched; anything else (VP9, AV1, MPEG-4…) is re-encoded.
        let copyable = videoCodec == nil || videoCodec == "h264" || videoCodec == "hevc"
        let video = (info.playback?.video == "transcode" || !copyable) ? "transcode" : "copy"

        let tracks = (info.audio ?? []).sorted { $0.position < $1.position }
        let defaultAudio = (tracks.first { $0.default == true } ?? tracks.first)?.position ?? 0
        let audio = info.playback?.audioPosition ?? info.chosen?.audioPosition ?? defaultAudio
        let track = tracks.first { $0.position == audio }
        let audioPlays = track.map { nativeAudio.contains($0.codec?.lowercased() ?? "") } ?? true

        // Files straight off disk can be tagged `hev1`, which AVPlayer refuses; the server re-tags HEVC as
        // `hvc1` when it repackages, so only H.264 plays untouched.
        let direct = nativeContainer && video == "copy" && videoCodec != "hevc"
            && (tracks.isEmpty || (audio == defaultAudio && audioPlays))
        if direct {
            return Plan(kind: .direct, path: file, start: start, video: "copy")
        }

        var query = "remux=1&hls=1&audio=\(audio)&video=\(video)"
        if video == "copy" && videoCodec == "hevc" { query += "&codec=hevc" }
        query += "&start=\(start)"
        return Plan(kind: .hls, path: "\(file)?\(query)", start: start, video: video)
    }
}
