import XCTest

/// Walks the iPhone app against a running Kiwi API and keeps a screenshot of each screen.
///
/// Needs a live server and an unlocked profile, so it skips unless both are named:
///
///     TEST_RUNNER_KIWI_SERVER=http://localhost:3333 TEST_RUNNER_KIWI_PROFILE=<name> \
///       xcodebuild test -project Kiwi.xcodeproj -scheme KiwiiOS \
///       -destination 'platform=iOS Simulator,name=iPhone 18 Pro' -only-testing:KiwiiOSUITests
final class KiwiPhoneTourTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testTour() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let server = environment["KIWI_SERVER"], let profile = environment["KIWI_PROFILE"] else {
            throw XCTSkip("Set TEST_RUNNER_KIWI_SERVER and TEST_RUNNER_KIWI_PROFILE to run the tour.")
        }

        let app = XCUIApplication()
        app.launchArguments += ["-kiwi.serverURL", server]
        app.launch()

        // Profile picker, unless the app kept the profile from an earlier run.
        let picker = app.staticTexts["Who's watching?"]
        let heroList = app.buttons["My List"].firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 15) || heroList.waitForExistence(timeout: 15), "Neither the profile picker nor Home appeared")
        if picker.exists {
            snapshot("01-profiles")
            let tile = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", profile)).firstMatch
            XCTAssertTrue(tile.waitForExistence(timeout: 5))
            tile.tap()
        }

        // Home: header, chips, hero, then rows (On Now, Top 10…)
        XCTAssertTrue(heroList.waitForExistence(timeout: 30), "Home never showed its hero card")
        sleep(3)
        snapshot("02-home")
        app.swipeUp()
        sleep(2)
        snapshot("03-home-rows")
        app.swipeUp()
        sleep(2)
        snapshot("04-home-rows-2")
        app.swipeDown()
        app.swipeDown()
        app.swipeDown()
        sleep(1)

        // Title page from the hero, then like it
        heroList.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: -6)).tap()
        let play = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Play' OR label BEGINSWITH 'Resume'")).firstMatch
        XCTAssertTrue(play.waitForExistence(timeout: 15), "The title page never showed a Play button")
        sleep(3)
        snapshot("05-title")
        let like = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Like' OR label CONTAINS 'like more'")).firstMatch
        if like.waitForExistence(timeout: 5) {
            if !like.isHittable { app.swipeUp() }
            like.tap()
            usleep(300_000)
            snapshot("06-title-liked")
        }
        app.navigationBars.buttons.firstMatch.tap()
        sleep(1)

        // Live
        app.tabBars.buttons["Live"].tap()
        sleep(5)
        snapshot("07-live")
        let watch = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Watch'")).firstMatch
        if watch.waitForExistence(timeout: 5) {
            watch.tap()
            sleep(15)
            snapshot("08-live-player")
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            sleep(1)
            let close = app.buttons["Close"]
            if close.exists { close.tap() } else { app.swipeDown() }
            sleep(3)
        }

        // Clips
        app.tabBars.buttons["Clips"].tap()
        sleep(6)
        snapshot("09-clips")

        // My Kiwi
        app.tabBars.buttons[profile].tap()
        sleep(4)
        snapshot("10-my-kiwi")
    }

    @MainActor
    private func snapshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
