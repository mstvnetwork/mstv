export async function onRequest(context) {

    // Your playlist JSON
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

        schedule =
            await response.json();


        /*
         * Make sure we actually received an array.
         */
        if (!Array.isArray(schedule)) {
            throw new Error(
                "Playlist JSON is not an array"
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
             * The frontend now knows every object and can
             * advance:
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
