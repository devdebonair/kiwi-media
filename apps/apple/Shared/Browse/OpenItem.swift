import SwiftUI

extension EnvironmentValues {
    /// What selecting a card does; each tab's navigation stack supplies it.
    @Entry var openItem: (TileItem) -> Void = { _ in }
}
