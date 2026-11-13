import SwiftUI

/// Kiwi's multi-level like: each tap adds a like, up to five ("Like" … "Adored"). The heart fills and warms
/// with the level, and a burst of small hearts plays on every tap.
struct LikeButton: View {
    let level: Int
    /// A round glass button with the label underneath (Clips rail) instead of an icon over a label (title page).
    var compact = false
    let action: () -> Void

    @State private var burst = 0

    var body: some View {
        Button {
            burst += 1
            action()
        } label: {
            VStack(spacing: 6) {
                if compact {
                    heart
                        .font(.system(size: 22, weight: .semibold))
                        .frame(width: 50, height: 50)
                        .glassEffect(.regular.interactive(), in: .circle)
                } else {
                    heart.font(.title2)
                }
                Text(LikeLevel.label(level))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(compact ? .white : .primary)
                    .contentTransition(.numericText())
            }
            .overlay { HeartBurst(trigger: burst, count: 4 + level * 2).allowsHitTesting(false) }
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.impact(weight: .light, intensity: 0.4 + Double(level) * 0.12), trigger: burst)
        .accessibilityLabel(level > 0 ? "\(LikeLevel.label(level)), like more" : "Like")
    }

    private var heart: some View {
        Image(systemName: level > 0 ? "heart.fill" : "heart")
            .foregroundStyle(level > 0 ? AnyShapeStyle(Self.color(level)) : AnyShapeStyle(.white))
            .symbolEffect(.bounce, value: burst)
            .contentTransition(.symbolEffect(.replace))
    }

    /// Pink at one like, deepening to red at five.
    static func color(_ level: Int) -> Color {
        let t = Double(min(max(level, 1), LikeLevel.maximum) - 1) / Double(LikeLevel.maximum - 1)
        return Color(hue: 0.97 - t * 0.04, saturation: 0.55 + t * 0.4, brightness: 1)
    }
}

/// Small hearts that float up and fade each time `trigger` changes.
struct HeartBurst: View {
    let trigger: Int
    var count = 8

    var body: some View {
        ZStack {
            ForEach(0..<count, id: \.self) { index in
                Particle(trigger: trigger, index: index, count: count)
            }
        }
    }

    private struct Particle: View {
        let trigger: Int
        let index: Int
        let count: Int

        var body: some View {
            let angle = (Double(index) / Double(max(count, 1))) * .pi - .pi
            Image(systemName: "heart.fill")
                .font(.system(size: CGFloat(10 + (index % 3) * 5)))
                .foregroundStyle(LikeButton.color(1 + index % LikeLevel.maximum))
                .keyframeAnimator(initialValue: Frame(), trigger: trigger) { view, frame in
                    view
                        .offset(x: frame.distance * cos(angle), y: frame.distance * sin(angle) - frame.rise)
                        .scaleEffect(frame.scale)
                        .opacity(frame.opacity)
                } keyframes: { _ in
                    KeyframeTrack(\.opacity) {
                        LinearKeyframe(trigger == 0 ? 0 : 1, duration: 0.05)
                        LinearKeyframe(0, duration: 0.7)
                    }
                    KeyframeTrack(\.distance) {
                        SpringKeyframe(trigger == 0 ? 0 : CGFloat(30 + index % 4 * 12), duration: 0.6)
                    }
                    KeyframeTrack(\.rise) {
                        LinearKeyframe(trigger == 0 ? 0 : 40, duration: 0.75)
                    }
                    KeyframeTrack(\.scale) {
                        SpringKeyframe(1.2, duration: 0.25)
                        LinearKeyframe(0.6, duration: 0.5)
                    }
                }
        }
    }

    struct Frame {
        var opacity: Double = 0
        var distance: CGFloat = 0
        var rise: CGFloat = 0
        var scale: CGFloat = 0.4
    }
}
