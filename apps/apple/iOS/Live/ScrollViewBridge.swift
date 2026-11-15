import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// The `UIScrollView` behind a SwiftUI `ScrollView`, once `ScrollViewBridge` has found it, and whether a
/// pinch on it is underway.
final class ScrollHandle {
    weak var view: UIScrollView?

    private var isPinching = false
    private var tapsBlockedUntil = Date.distantPast

    /// False while a pinch is underway and for a moment after, so a finger lifting off a channel mid-pinch
    /// (or just after) doesn't tune to it. Taps in the guide check this before acting.
    var allowsTaps: Bool { !isPinching && Date.now >= tapsBlockedUntil }

    fileprivate func pinchBegan() { isPinching = true }

    fileprivate func pinchEnded() {
        isPinching = false
        tapsBlockedUntil = .now + 0.35
    }
}

enum PinchEvent {
    /// Where the fingers started, in the scroll view's visible area.
    case began(CGPoint)
    /// Scale since the pinch began: above 1 spreading apart, below 1 pinching together.
    case changed(CGFloat)
    case ended(CGFloat)
}

/// Placed in a `ScrollView`'s content, reaches the `UIScrollView` behind it for what SwiftUI doesn't offer:
/// - No rubber-banding past the edges, which would pull the guide away from its pinned column and ruler.
/// - Optional directional lock, so a drag scrolls across or down, not diagonally.
/// - A pinch that takes over the moment a second finger lands (see `TwoFingerZoomGestureRecognizer`) and
///   pauses scrolling while it runs, so zooming can keep the content under the fingers in place.
struct ScrollViewBridge: UIViewRepresentable {
    let handle: ScrollHandle
    var locksDirection = false
    let onPinch: (PinchEvent) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        let coordinator = context.coordinator
        coordinator.onPinch = onPinch
        // The view is only inside the scroll view's hierarchy once SwiftUI has placed it.
        DispatchQueue.main.async { [weak view] in
            guard let scrollView = view?.enclosingScrollView else { return }
            coordinator.attach(to: scrollView, handle: handle, locksDirection: locksDirection)
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onPinch: (PinchEvent) -> Void = { _ in }
        private weak var scrollView: UIScrollView?
        private var handle: ScrollHandle?
        private lazy var pinch: TwoFingerZoomGestureRecognizer = {
            let recognizer = TwoFingerZoomGestureRecognizer(target: self, action: #selector(pinched(_:)))
            recognizer.delegate = self
            return recognizer
        }()

        /// Real fingers rarely land together: the first one starts the scroll view's pan before the second
        /// arrives, and by default a recognizer can't begin while another on the same view is running. Letting
        /// the zoom run alongside the pan means it still begins; `pinched` then switches the pan off for its
        /// duration. Only the pan: everything else, including taps on channels and programs, must give way,
        /// so a pinch cancels any tap in progress.
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            otherGestureRecognizer === scrollView?.panGestureRecognizer
        }

        func attach(to scrollView: UIScrollView, handle: ScrollHandle, locksDirection: Bool) {
            handle.view = scrollView
            self.handle = handle
            scrollView.bouncesHorizontally = false
            scrollView.bouncesVertically = false
            scrollView.isDirectionalLockEnabled = locksDirection
            guard self.scrollView !== scrollView else { return }
            self.scrollView?.removeGestureRecognizer(pinch)
            self.scrollView = scrollView
            scrollView.addGestureRecognizer(pinch)
        }

        @objc private func pinched(_ recognizer: TwoFingerZoomGestureRecognizer) {
            guard let scrollView else { return }
            switch recognizer.state {
            case .began:
                handle?.pinchBegan()
                // Stop any glide left over from a flick, then hold the content still for the zoom.
                scrollView.setContentOffset(scrollView.contentOffset, animated: false)
                scrollView.panGestureRecognizer.isEnabled = false
                let point = recognizer.location(in: scrollView)
                onPinch(.began(CGPoint(x: point.x - scrollView.contentOffset.x, y: point.y - scrollView.contentOffset.y)))
                onPinch(.changed(recognizer.scale))
            case .changed:
                onPinch(.changed(recognizer.scale))
            case .ended, .cancelled, .failed:
                handle?.pinchEnded()
                scrollView.panGestureRecognizer.isEnabled = true
                onPinch(.ended(recognizer.scale))
            default:
                break
            }
        }
    }
}

/// A pinch that begins the moment a second finger touches down, not after the fingers have spread or closed by
/// some distance like `UIPinchGestureRecognizer`. Real fingers rarely land together, so with the system pinch the
/// first finger's scroll usually wins before the pinch is sure of itself. Here the rule is simple: one finger
/// scrolls, two fingers zoom.
///
/// - Nothing can stop it from beginning. A finger that lands on a channel or program starts that button's own
///   gesture, which would otherwise block this one; instead this one begins anyway and cancels the button's.
/// - Once begun it lasts until every finger has lifted. Lifting one finger and putting it back carries on from
///   the same zoom, so a pinch can be done in several strokes.
///
/// `scale` is the zoom since the gesture began.
final class TwoFingerZoomGestureRecognizer: UIGestureRecognizer {
    private(set) var scale: CGFloat = 1
    /// Up to two fingers on the glass, in the order they landed. A third finger is ignored.
    private var fingers: [UITouch] = []
    /// The finger distance and scale when the current pair of fingers came together.
    private var strokeDistance: CGFloat = 1
    private var strokeScale: CGFloat = 1

    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        for touch in touches where fingers.count < 2 {
            fingers.append(touch)
        }
        guard fingers.count == 2 else { return }
        // Fingers that land almost on top of each other would make tiny movements look like huge zooms.
        strokeDistance = max(distance, 30)
        strokeScale = scale
        if state == .possible { state = .began }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard state == .began || state == .changed, fingers.count == 2 else { return }
        scale = strokeScale * distance / strokeDistance
        state = .changed
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        lift(touches, cancelled: false)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        lift(touches, cancelled: true)
    }

    override func reset() {
        fingers = []
        scale = 1
        strokeDistance = 1
        strokeScale = 1
    }

    private func lift(_ touches: Set<UITouch>, cancelled: Bool) {
        fingers.removeAll { touches.contains($0) }
        guard fingers.isEmpty else { return }
        switch state {
        case .began, .changed:
            state = cancelled ? .cancelled : .ended
        case .possible:
            // One finger came and went without a second: never a pinch.
            state = .failed
        default:
            break
        }
    }

    private var distance: CGFloat {
        let a = fingers[0].location(in: view)
        let b = fingers[1].location(in: view)
        return hypot(a.x - b.x, a.y - b.y)
    }
}

private extension UIView {
    var enclosingScrollView: UIScrollView? {
        var current = superview
        while let view = current {
            if let scrollView = view as? UIScrollView { return scrollView }
            current = view.superview
        }
        return nil
    }
}

/// Haptics that run through a pinch, so zooming the guide has a physical feel:
/// - a light tick at each zoom step (evenly spaced on a log scale, so every step feels the same size),
/// - a firm bump on reaching the closest or widest zoom,
/// - a stronger bump when the pinch has gone far enough to switch layouts (and a softer one if it eases back),
/// - and a confirming tap when the switch happens on release.
final class PinchHaptics {
    private var ticks: UISelectionFeedbackGenerator?
    private var bump: UIImpactFeedbackGenerator?
    private var threshold: UIImpactFeedbackGenerator?
    private var step: Int?
    private var atLimit = false
    private var armed = false

    /// Zoom levels between ticks: about eight across the timeline's range.
    private static let stepRatio: CGFloat = 1.2

    func began(at zoom: CGFloat, in view: UIView?) {
        if let view {
            ticks = UISelectionFeedbackGenerator(view: view)
            bump = UIImpactFeedbackGenerator(style: .rigid, view: view)
            threshold = UIImpactFeedbackGenerator(style: .medium, view: view)
        }
        ticks?.prepare()
        bump?.prepare()
        threshold?.prepare()
        step = Self.step(zoom)
        atLimit = false
        armed = false
    }

    /// The zoom moved to `zoom`; `limited` when the pinch is pushing past the closest or widest zoom.
    func zoomed(to zoom: CGFloat, limited: Bool) {
        let current = Self.step(zoom)
        if current != step, !limited {
            step = current
            ticks?.selectionChanged()
            ticks?.prepare()
        }
        if limited, !atLimit { bump?.impactOccurred(intensity: 0.8) }
        atLimit = limited
    }

    /// Whether letting go now would switch layouts.
    func setArmed(_ isArmed: Bool) {
        guard isArmed != armed else { return }
        armed = isArmed
        threshold?.impactOccurred(intensity: isArmed ? 1 : 0.45)
    }

    /// The pinch ended and switched layouts.
    func committed() {
        threshold?.impactOccurred(intensity: 0.7)
        ticks = nil
        bump = nil
        threshold = nil
    }

    private static func step(_ zoom: CGFloat) -> Int {
        Int((log(max(zoom, 0.01)) / log(stepRatio)).rounded(.down))
    }
}
