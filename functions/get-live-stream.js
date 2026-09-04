export async function onRequest(context) {

    const rawJsonUrl =
        "https://crickethd.pages.dev/playlist200.json";

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

    const now =
        new Date();

    const currentSecondsInDay =
        (now.getUTCHours() * 3600) +
        (now.getUTCMinutes() * 60) +
        now.getUTCSeconds();

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

    let playedSeconds =
        currentSecondsInDay -
        showStartSecondsInDay;

    if (
        !Number.isFinite(playedSeconds) ||
        playedSeconds < 0
    ) {
        playedSeconds = 0;
    }

    return new Response(

        JSON.stringify({
            playlist: schedule,
            playlistIndex: currentIndex,
            title:
                currentShow.title || "",
            url:
                currentShow.url || "",
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
