import SwiftUI

struct ProgressBar: View {
    let value: Double
    var height: CGFloat = 6

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(.white.opacity(0.3))
                Capsule().fill(Theme.accent).frame(width: max(height, proxy.size.width * value))
            }
        }
        .frame(height: height)
    }
}
