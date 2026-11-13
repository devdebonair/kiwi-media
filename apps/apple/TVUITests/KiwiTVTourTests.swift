import XCTest

/// Walks the app with the Siri Remote against a running Kiwi API and keeps a screenshot of each screen.
///
/// Needs a live server and an unlocked profile, so it skips unless both are named:
///
///     TEST_RUNNER_KIWI_SERVER=http://localhost:3333 TEST_RUNNER_KIWI_PROFILE=<name> \
///       xcodebuild test -project Kiwi.xcodeproj -scheme KiwiTV \
///       -destination 'platform=tvOS Simulator,name=Apple TV 4K (4th generation)' -only-testing:KiwiTVUITests
final class KiwiTVTourTests: XCTestCase {
    @MainActor private var remote: XCUIRemote { XCUIRemote.shared }
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testTour() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let server = environment["KIWI_SERVER"], let profile = environment["KIWI_PROFILE"] else {
            throw XCTSkip("Set TEST_RUNNER_KIWI_SERVER and TEST_RUNNER_KIWI_PROFILE to run the tour.")
        }

        app = XCUIApplication()
        app.launchArguments += ["-kiwi.serverURL", server]
        app.launch()

        // Profile picker, unless the app kept the profile from an earlier run.
        let picker = app.staticTexts["Who's watching?"]
        let moreInfo = app.buttons["More Info"]
        XCTAssertTrue(picker.waitForExistence(timeout: 15) || moreInfo.waitForExistence(timeout: 15), "Neither the profile picker nor Home appeared")
        if picker.exists {
            snapshot("01-profiles")
            let tile = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", profile)).firstMatch
            XCTAssertTrue(tile.waitForExistence(timeout: 5))
            try focus(tile, moving: .right)
            remote.press(.select)
        }

        // Home: the billboard describes whatever card has focus.
        XCTAssertTrue(moreInfo.waitForExistence(timeout: 30), "Home never showed its billboard")
        sleep(3)
        snapshot("02-home")
        remote.press(.down)
        sleep(2)
        snapshot("03-home-row")
        for _ in 0..<3 { remote.press(.down); usleep(600_000) }
        sleep(2)
        snapshot("04-home-rows")
        remote.press(.right)
        sleep(2)
        snapshot("05-home-billboard-follows")

        // Title page from the billboard, then like it
        let billboardPlay = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Play' OR label BEGINSWITH 'Resume' OR label BEGINSWITH 'Watch'")).firstMatch
        try focus(billboardPlay, moving: .up)
        try focus(moreInfo, moving: .right)
        remote.press(.select)
        let like = app.buttons.matching(NSPredicate(format: "label IN {'Like', 'Liked', 'Really like', 'Love it', 'Love it!', 'Adored'}")).firstMatch
        XCTAssertTrue(like.waitForExistence(timeout: 15), "The title page never showed a Like button")
        sleep(2)
        snapshot("06-title")
        try focus(like, moving: .right)
        remote.press(.select)
        sleep(1)
        snapshot("07-title-liked")
        remote.press(.menu)
        sleep(2)

        remote.press(.menu)
        sleep(1)
        // The profile tab: account bar, Continue Watching, Liked, My List. Menu from Home's rows goes to the
        // top navigation.
        let profileTab = app.buttons[profile]
        if profileTab.waitForExistence(timeout: 5) {
            try focus(profileTab, moving: .right)
            sleep(1)
            remote.press(.select)
            sleep(4)
            remote.press(.down)
            sleep(2)
            snapshot("08-profile-tab")
            remote.press(.menu)
            sleep(1)
        }

        // Live: up to the top navigation, across to Live, down into the guide.
        let liveTab = app.buttons["Live"]
        if liveTab.waitForExistence(timeout: 5) {
            try focus(liveTab, moving: .left)
            sleep(1)
            remote.press(.select)
            sleep(4)
            remote.press(.down)
            sleep(2)
            remote.press(.down)
            sleep(2)
            snapshot("09-live-guide")
            remote.press(.select)
            sleep(15)
            snapshot("10-live-player")
            remote.press(.up)
            sleep(2)
            snapshot("11-live-transport")
        }
    }

    /// Presses `direction` until `element` has focus.
    @MainActor
    private func focus(_ element: XCUIElement, moving direction: XCUIRemote.Button, attempts: Int = 12) throws {
        for _ in 0..<attempts {
            if element.exists && element.hasFocus { return }
            remote.press(direction)
            usleep(400_000)
        }
        if !(element.exists && element.hasFocus) {
            snapshot("focus-failed-\(element.label)")
            XCTFail("Couldn't move focus to \(element.label)")
        }
    }

    @MainActor
    private func snapshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
