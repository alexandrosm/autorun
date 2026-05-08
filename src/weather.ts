import type { WeatherSnapshot } from "./types";

export const emptyWeatherSnapshot = (includeCoordinates = false): WeatherSnapshot => ({
  source: "open_meteo",
  fetched_at_utc: null,
  ...(includeCoordinates ? { latitude: null, longitude: null } : {}),
  temperature_f: null,
  relative_humidity_percent: null,
  apparent_temperature_f: null,
  precipitation_in: null,
  rain_in: null,
  weather_code: null,
  cloud_cover_percent: null,
  wind_speed_mph: null,
  wind_direction_degrees: null,
  wind_gusts_mph: null,
  raw: null,
});

export async function fetchOpenMeteoWeather(lat: number, lon: number): Promise<WeatherSnapshot> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current:
      "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    timezone: "America/Los_Angeles",
  });

  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Open-Meteo request failed with ${response.status}`);
  }

  const raw = await response.json();
  const current = raw.current ?? {};

  return {
    source: "open_meteo",
    fetched_at_utc: new Date().toISOString(),
    latitude: lat,
    longitude: lon,
    temperature_f: numberOrNull(current.temperature_2m),
    relative_humidity_percent: numberOrNull(current.relative_humidity_2m),
    apparent_temperature_f: numberOrNull(current.apparent_temperature),
    precipitation_in: numberOrNull(current.precipitation),
    rain_in: numberOrNull(current.rain),
    weather_code: numberOrNull(current.weather_code),
    cloud_cover_percent: numberOrNull(current.cloud_cover),
    wind_speed_mph: numberOrNull(current.wind_speed_10m),
    wind_direction_degrees: numberOrNull(current.wind_direction_10m),
    wind_gusts_mph: numberOrNull(current.wind_gusts_10m),
    raw,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
