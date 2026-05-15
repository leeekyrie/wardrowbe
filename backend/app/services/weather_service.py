import json
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx
import redis.asyncio as aioredis

from app.config import get_settings
from app.utils.redis_lock import get_redis

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class WeatherData:
    temperature: float  # Celsius
    feels_like: float  # Apparent temperature
    humidity: int  # Percentage
    precipitation_chance: int  # Percentage
    precipitation_mm: float  # mm in next hour
    wind_speed: float  # km/h
    condition: str  # sunny, cloudy, rainy, snowy, etc.
    condition_code: int  # WMO weather code
    is_day: bool
    uv_index: float
    timestamp: datetime

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "temperature": self.temperature,
            "feels_like": self.feels_like,
            "humidity": self.humidity,
            "precipitation_chance": self.precipitation_chance,
            "precipitation_mm": self.precipitation_mm,
            "wind_speed": self.wind_speed,
            "condition": self.condition,
            "condition_code": self.condition_code,
            "is_day": self.is_day,
            "uv_index": self.uv_index,
            "timestamp": self.timestamp.isoformat(),
        }


@dataclass
class DailyForecast:
    """Daily weather forecast."""

    date: str  # YYYY-MM-DD
    temp_min: float
    temp_max: float
    precipitation_chance: int
    condition: str
    condition_code: int


# QWeather icon code interpretation.
# https://dev.qweather.com/en/docs/resource/icons-info/
QWEATHER_ICON_CODES = {
    100: "sunny",
    101: "cloudy",
    102: "partly cloudy",
    103: "partly cloudy",
    104: "overcast",
    150: "clear",
    151: "cloudy",
    152: "partly cloudy",
    153: "partly cloudy",
    300: "shower rain",
    301: "heavy shower rain",
    302: "thunderstorm",
    303: "heavy thunderstorm",
    304: "thunderstorm with hail",
    305: "light rain",
    306: "rain",
    307: "heavy rain",
    308: "extreme rain",
    309: "drizzle",
    310: "rainstorm",
    311: "heavy rainstorm",
    312: "severe rainstorm",
    313: "freezing rain",
    314: "light to moderate rain",
    315: "moderate to heavy rain",
    316: "heavy rain to rainstorm",
    317: "rainstorm to heavy rainstorm",
    318: "heavy to severe rainstorm",
    350: "shower rain",
    351: "heavy shower rain",
    399: "rain",
    400: "light snow",
    401: "snow",
    402: "heavy snow",
    403: "snowstorm",
    404: "sleet",
    405: "rain and snow",
    406: "shower rain and snow",
    407: "snow shower",
    408: "light to moderate snow",
    409: "moderate to heavy snow",
    410: "heavy snow to snowstorm",
    456: "shower rain and snow",
    457: "snow shower",
    499: "snow",
    500: "foggy",
    501: "foggy",
    502: "haze",
    503: "sand",
    504: "dust",
    507: "duststorm",
    508: "sandstorm",
    509: "foggy",
    510: "foggy",
    511: "haze",
    512: "haze",
    513: "haze",
    514: "foggy",
    515: "foggy",
}


CACHE_TTL = 3600  # 1 hour
CACHE_PREFIX = "weather:"


class WeatherService:
    def __init__(self):
        self.base_url = settings.qweather_api_host.rstrip("/")

    @staticmethod
    def _cache_key(lat: float, lon: float) -> str:
        return f"{CACHE_PREFIX}{round(lat, 2)},{round(lon, 2)}"

    @staticmethod
    def _forecast_cache_key(lat: float, lon: float, days: int) -> str:
        return f"{CACHE_PREFIX}forecast:{round(lat, 2)},{round(lon, 2)}:{days}"

    async def _cache_get(self, lat: float, lon: float) -> WeatherData | None:
        try:
            redis = await get_redis()
            raw = await redis.get(self._cache_key(lat, lon))
        except aioredis.RedisError:
            logger.debug(f"Redis unavailable for weather cache read ({lat}, {lon})")
            return None
        if raw is None:
            return None
        data = json.loads(raw)
        data["timestamp"] = datetime.fromisoformat(data["timestamp"])
        logger.debug(f"Weather cache hit for ({lat}, {lon})")
        return WeatherData(**data)

    async def _cache_set(self, lat: float, lon: float, data: WeatherData) -> None:
        try:
            redis = await get_redis()
            await redis.set(
                self._cache_key(lat, lon),
                json.dumps(data.to_dict()),
                ex=CACHE_TTL,
            )
        except aioredis.RedisError:
            logger.debug(f"Redis unavailable for weather cache write ({lat}, {lon})")

    async def _forecast_cache_get(
        self, lat: float, lon: float, days: int
    ) -> list[DailyForecast] | None:
        try:
            redis = await get_redis()
            raw = await redis.get(self._forecast_cache_key(lat, lon, days))
        except aioredis.RedisError:
            logger.debug(f"Redis unavailable for forecast cache read ({lat}, {lon})")
            return None
        if raw is None:
            return None
        data = json.loads(raw)
        logger.debug(f"Weather forecast cache hit for ({lat}, {lon})")
        return [DailyForecast(**item) for item in data]

    async def _forecast_cache_set(
        self, lat: float, lon: float, days: int, data: list[DailyForecast]
    ) -> None:
        try:
            redis = await get_redis()
            await redis.set(
                self._forecast_cache_key(lat, lon, days),
                json.dumps([item.__dict__ for item in data]),
                ex=CACHE_TTL,
            )
        except aioredis.RedisError:
            logger.debug(f"Redis unavailable for forecast cache write ({lat}, {lon})")

    def _validate_coordinates(self, latitude: float, longitude: float) -> None:
        """Validate latitude and longitude bounds."""
        if not -90 <= latitude <= 90:
            raise ValueError(f"Invalid latitude {latitude}: must be between -90 and 90")
        if not -180 <= longitude <= 180:
            raise ValueError(f"Invalid longitude {longitude}: must be between -180 and 180")

    def _interpret_weather_code(self, code: int, text: str | None = None) -> str:
        """Convert QWeather icon code to a stable, lower-case condition."""
        if code in QWEATHER_ICON_CODES:
            return QWEATHER_ICON_CODES[code]
        if text:
            return text.strip().lower()
        return "unknown"

    def _auth_headers(self) -> dict[str, str]:
        if settings.qweather_jwt:
            return {"Authorization": f"Bearer {settings.qweather_jwt}"}
        if settings.qweather_api_key:
            return {"X-QW-Api-Key": settings.qweather_api_key}
        return {}

    @staticmethod
    def _format_location(latitude: float, longitude: float) -> str:
        return f"{longitude:.2f},{latitude:.2f}"

    @staticmethod
    def _to_float(value: Any, default: float = 0.0) -> float:
        try:
            if value is None or value == "":
                return default
            return float(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _to_int(value: Any, default: int = 0) -> int:
        try:
            if value is None or value == "":
                return default
            return int(float(value))
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _parse_timestamp(value: str | None) -> datetime:
        if not value:
            return datetime.utcnow()
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime.utcnow()

    @staticmethod
    def _forecast_endpoint_days(days: int) -> int:
        if days <= 3:
            return 3
        if days <= 7:
            return 7
        if days <= 10:
            return 10
        if days <= 15:
            return 15
        return 30

    def _ensure_success(self, data: dict[str, Any]) -> None:
        code = str(data.get("code", ""))
        if code and code != "200":
            raise WeatherServiceError(f"QWeather API returned code {code}")

    async def get_current_weather(
        self, latitude: float, longitude: float, use_cache: bool = True
    ) -> WeatherData:
        """
        Fetch current weather for a location.

        Args:
            latitude: Location latitude
            longitude: Location longitude
            use_cache: Whether to use cached data if available

        Returns:
            WeatherData with current conditions

        Raises:
            ValueError: If coordinates are out of bounds
            WeatherServiceError: If API request fails
        """
        self._validate_coordinates(latitude, longitude)

        if use_cache:
            cached = await self._cache_get(latitude, longitude)
            if cached:
                return cached

        params = {
            "location": self._format_location(latitude, longitude),
            "lang": settings.qweather_lang,
            "unit": "m",
        }

        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            try:
                response = await client.get(
                    f"{self.base_url}/v7/weather/now",
                    params=params,
                    headers=self._auth_headers(),
                )
                response.raise_for_status()
                data = response.json()
            except httpx.HTTPError as e:
                logger.error(f"QWeather API error: {e}")
                raise WeatherServiceError(f"Failed to fetch weather: {e}") from None

        self._ensure_success(data)
        current = data.get("now", {})
        weather_code = self._to_int(current.get("icon"))
        precipitation_mm = self._to_float(current.get("precip"))

        weather = WeatherData(
            temperature=self._to_float(current.get("temp")),
            feels_like=self._to_float(current.get("feelsLike")),
            humidity=self._to_int(current.get("humidity")),
            precipitation_chance=100 if precipitation_mm > 0 else 0,
            precipitation_mm=precipitation_mm,
            wind_speed=self._to_float(current.get("windSpeed")),
            condition=self._interpret_weather_code(weather_code, current.get("text")),
            condition_code=weather_code,
            is_day=not str(weather_code).startswith(("15", "35", "45")),
            uv_index=0,
            timestamp=self._parse_timestamp(current.get("obsTime")),
        )

        await self._cache_set(latitude, longitude, weather)

        logger.info(
            f"Weather fetched for ({latitude}, {longitude}): "
            f"{weather.temperature}°C, {weather.condition}"
        )

        return weather

    async def get_daily_forecast(
        self, latitude: float, longitude: float, days: int = 7
    ) -> list[DailyForecast]:
        """
        Fetch daily forecast for a location.

        Args:
            latitude: Location latitude
            longitude: Location longitude
            days: Number of days to forecast (1-16)

        Returns:
            List of DailyForecast objects

        Raises:
            ValueError: If coordinates are out of bounds
            WeatherServiceError: If API request fails
        """
        self._validate_coordinates(latitude, longitude)

        requested_days = min(days, 16)
        cached = await self._forecast_cache_get(latitude, longitude, requested_days)
        if cached:
            return cached

        endpoint_days = self._forecast_endpoint_days(requested_days)
        params = {
            "location": self._format_location(latitude, longitude),
            "lang": settings.qweather_lang,
            "unit": "m",
        }

        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            try:
                response = await client.get(
                    f"{self.base_url}/v7/weather/{endpoint_days}d",
                    params=params,
                    headers=self._auth_headers(),
                )
                response.raise_for_status()
                data = response.json()
            except httpx.HTTPError as e:
                logger.error(f"QWeather API error: {e}")
                raise WeatherServiceError(f"Failed to fetch forecast: {e}") from None

        self._ensure_success(data)

        forecasts = []
        for item in data.get("daily", [])[:requested_days]:
            code = self._to_int(item.get("iconDay"))
            precipitation_mm = self._to_float(item.get("precip"))
            forecasts.append(
                DailyForecast(
                    date=item.get("fxDate", ""),
                    temp_max=self._to_float(item.get("tempMax")),
                    temp_min=self._to_float(item.get("tempMin")),
                    precipitation_chance=100 if precipitation_mm > 0 else 0,
                    condition=self._interpret_weather_code(code, item.get("textDay")),
                    condition_code=code,
                )
            )

        await self._forecast_cache_set(latitude, longitude, requested_days, forecasts)
        return forecasts

    async def get_tomorrow_weather(self, latitude: float, longitude: float) -> WeatherData:
        """
        Fetch tomorrow's weather forecast and return as WeatherData.

        This is used for day-before notifications where we need to recommend
        outfits based on tomorrow's expected weather.

        Args:
            latitude: Location latitude
            longitude: Location longitude

        Returns:
            WeatherData with tomorrow's forecast (avg temp, conditions)
        """
        forecasts = await self.get_daily_forecast(latitude, longitude, days=2)

        if len(forecasts) < 2:
            # Fallback to current weather if forecast fails
            logger.warning("Could not get tomorrow's forecast, using current weather")
            return await self.get_current_weather(latitude, longitude)

        tomorrow = forecasts[1]  # Index 0 is today, 1 is tomorrow

        # Use average of min/max for the representative temperature
        avg_temp = (tomorrow.temp_min + tomorrow.temp_max) / 2
        # Use the max temp for feels_like (daytime outfit)
        feels_like = tomorrow.temp_max

        return WeatherData(
            temperature=round(avg_temp, 1),
            feels_like=round(feels_like, 1),
            humidity=50,  # Not available in daily forecast, use typical value
            precipitation_chance=tomorrow.precipitation_chance,
            precipitation_mm=0,  # Not available for forecast
            wind_speed=0,  # Not available in daily forecast
            condition=tomorrow.condition,
            condition_code=tomorrow.condition_code,
            is_day=True,  # Assume daytime for outfit recommendations
            uv_index=0,  # Not available in daily forecast
            timestamp=datetime.utcnow(),
        )

    async def check_health(self) -> dict:
        """Check if the weather service is available."""
        try:
            async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
                response = await client.get(
                    f"{self.base_url}/v7/weather/now",
                    params={
                        "location": self._format_location(0, 0),
                        "lang": settings.qweather_lang,
                        "unit": "m",
                    },
                    headers=self._auth_headers(),
                )
                if response.status_code == 200 and str(response.json().get("code")) == "200":
                    return {"status": "healthy", "provider": "qweather"}
        except Exception as e:
            return {"status": "unhealthy", "error": str(e)}

        return {"status": "unhealthy", "error": "Unknown error"}


class WeatherServiceError(Exception):
    pass
