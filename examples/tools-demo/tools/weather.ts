/**
 * Demo tool that simulates weather data.
 * In a real workflow, this would call a weather API.
 */

export function get_weather(city: string): string {
  const conditions = ["sunny", "cloudy", "partly cloudy", "rainy", "stormy"];

  const weather = {
    city,
    temperature_f: Math.floor(Math.random() * (85 - 45 + 1)) + 45,
    condition: conditions[Math.floor(Math.random() * conditions.length)],
    humidity: Math.floor(Math.random() * (90 - 30 + 1)) + 30,
    wind_mph: Math.floor(Math.random() * 26),
    timestamp: new Date().toISOString(),
  };

  return JSON.stringify(weather, null, 2);
}
