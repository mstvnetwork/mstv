export async function onRequest(context) {

    const rawJsonUrl =
        "https://crickethd.pages.dev/playlist200.json";

    /* =========================================================
       LOAD PLAYLIST
       ========================================================= */

    let schedule = [];

    try {

        const response =
            await fetch(
                rawJsonUrl,
                {
                    cache: "no-store"
                }
            );

        if (!response.ok) {
            throw new Error(
                "Playlist HTTP " + response.status
            );
        }

        const parsed =
            await response.json();

        if (!Array.isArray(parsed)) {
            throw new Error(
                "Playlist JSON is not an array"
            );
        }

        /*
         * Filter out any entries missing a usable url, so a bad
         * entry doesn't get selected as "currentShow" and break
         * the frontend player.
         */
        schedule = parsed.filter(
            item => item && typeof item.url === "string" && item.url.trim() !== ""
        );

        if (schedule.length === 0) {
            throw new Error(
                "Playlist JSON has no valid url entries"
            );
        }

    } catch (err) {

        console.error(
            "Playlist fetch error:",
            err
        );

        /*
         * Emergency fallback.
         */
        schedule = [
            {
                startHour: 0,
                startMinute: 0,
                startSecond: 0,
                title: "Offline Loop",
                url: "https://mux.dev"
            }
        ];
    }

    /* =========================================================
       EMPTY PLAYLIST SAFETY
       (kept for defense-in-depth; schedule is never empty above,
       but this guarantees a consistent response shape either way)
       ========================================================= */

    if (schedule.length === 0) {

        return new Response(
            JSON.stringify({
                playlist: [],
                playlistIndex: -1,
                title: "Offline",
                url: "",
                played: 0
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-store"
                }
            }
        );
    }

    /* =========================================================
       CURRENT UTC TIME
       ========================================================= */

    const now =
        new Date();

    const currentSecondsInDay =
        (now.getUTCHours() * 3600) +
        (now.getUTCMinutes() * 60) +
        now.getUTCSeconds();

    /* =========================================================
       FIND CURRENT SCHEDULE ITEM
       ========================================================= */

    let currentIndex = 0;

    let currentShow =
        schedule[0];

    let showStartSecondsInDay = 0;

    for (
        let i = 0;
        i < schedule.length;
        i++
    ) {

        const startHour =
            Number(schedule[i].startHour) || 0;

        const startMinute =
            Number(schedule[i].startMinute) || 0;

        const startSecond =
            Number(schedule[i].startSecond) || 0;

        const showSeconds =
            (startHour * 3600) +
            (startMinute * 60) +
            startSecond;

        if (
            currentSecondsInDay >=
            showSeconds
        ) {

            currentShow =
                schedule[i];

            currentIndex =
                i;

            showStartSecondsInDay =
                showSeconds;
        }
    }

    /* =========================================================
       CALCULATE PLAYED TIME
       ========================================================= */

    let playedSeconds =
        currentSecondsInDay -
        showStartSecondsInDay;

    /*
     * Safety.
     */
    if (
        !Number.isFinite(playedSeconds) ||
        playedSeconds < 0
    ) {
        playedSeconds = 0;
    }

    /* =========================================================
       RETURN PLAYLIST + CURRENT POSITION
       ========================================================= */

    return new Response(

        JSON.stringify({

            /*
             * COMPLETE PLAYLIST
             *
             * The frontend uses playlistIndex to sync to the
             * server's schedule position, then advances locally
             * on each video's 'ended' event:
             *
             * 0 -> 1 -> 2 -> 0 -> 1 -> 2 ...
             */
            playlist: schedule,

            /*
             * Current item according to UTC schedule.
             */
            playlistIndex: currentIndex,

            /*
             * Current program information.
             */
            title:
                currentShow.title || "",

            url:
                currentShow.url || "",

            /*
             * How far into the current scheduled item
             * playback should begin.
             */
            played:
                playedSeconds
        }),

        {
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store"
            }
        }
    );
}
