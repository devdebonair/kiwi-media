import SwiftUI
import UIKit

/// A title's logo artwork, or its name in large type when there is no logo.
struct TitleTreatment: View {
    let title: String
    let logo: String?
    var maxWidth: CGFloat = 640
    var maxHeight: CGFloat = 160
    var fontSize: CGFloat = 76
    var textMaxWidth: CGFloat = 1100

    @Environment(APIClient.self) private var api
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: maxWidth, maxHeight: maxHeight, alignment: .bottomLeading)
            } else {
                Text(title)
                    .font(.system(size: fontSize, weight: .heavy))
                    .lineLimit(2)
                    .minimumScaleFactor(0.6)
                    .frame(maxWidth: textMaxWidth, alignment: .leading)
            }
        }
        .shadow(color: .black.opacity(0.5), radius: 12)
        .task(id: logo) {
            guard let url = api.url(logo) else {
                image = nil
                return
            }
            image = ImageCache.shared.image(for: url)
            if image == nil { image = await ImageCache.shared.load(url) }
        }
    }
}
