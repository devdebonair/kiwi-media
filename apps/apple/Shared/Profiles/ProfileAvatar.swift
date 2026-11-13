import SwiftUI

struct ProfileAvatar: View {
    let profile: Profile
    var size: CGFloat = 220

    var body: some View {
        ZStack {
            Circle().fill(Color(hex: profile.color))
            if let avatar = profile.avatar, !avatar.isEmpty {
                Text(avatar).font(.system(size: size * 0.5))
            } else {
                Text(profile.name.prefix(1).uppercased())
                    .font(.system(size: size * 0.45, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
    }
}
