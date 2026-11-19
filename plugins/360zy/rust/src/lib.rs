//! 360资源（360zy.com）API 型插件 —— Rust 复刻 JS 基线扩展的 latest/search。
//! JS 参考：`js_engine/assets/extensions/360zy.com.js`（hualiong, v0.0.2）。

use grain_pdk::{plugin_fn, plugin_meta, Error, HttpResponse, Result};
use serde_json::{json, Value};

plugin_meta! {
    "name": "360资源",
    "version": "v0.0.2",
    "type": "bangumi",
    "package": "360zy.com",
    "author": "hualiong",
    "lang": "zh-cn",
    "webSite": "https://360zy.com",
    "nsfw": false,
}

/// JS 基线版用自定义头做多域名并发竞速，WASM 宿主里没有对应物，这里串行故障转移。
const DOMAINS: [&str; 7] = [
    "360zy.com",
    "360zy.net",
    "360zy.top",
    "360zy.tv",
    "360zy1.com",
    "360zy2.com",
    "360zy3.com",
];

thread_local! {
    /// maccms `h` 参数（按更新小时过滤，JS 版恒带）。
    /// wasm 内无时钟，从 HTTP 响应 Date 头推导（东九区小时，0 归一为 24），缓存复用。
    static CACHED_H: ::std::cell::Cell<i32> = const { ::std::cell::Cell::new(-1) };
}

async fn fetch_vod(params: &str) -> Result<HttpResponse> {
    let mut last_err = String::from("no domain attempted");
    for domain in DOMAINS {
        let url = format!("https://{}/api.php/provide/vod?ac=detail{}", domain, params);
        match grain_pdk::http("GET", &url, "{}", "").await {
            Ok(resp) if resp.status == 200 && resp.body.trim_start().starts_with('{') => {
                return Ok(resp);
            }
            Ok(resp) => last_err = format!("{}: HTTP {}", domain, resp.status),
            Err(e) => last_err = format!("{}: {}", domain, e),
        }
        grain_pdk::log(
            grain_pdk::LogLevel::Warn,
            &format!("[360zy] {} failed: {}", domain, last_err),
        );
    }
    Err(Error::msg(format!(
        "all 360zy domains failed, last: {}",
        last_err
    )))
}

fn maybe_cache_h(resp: &HttpResponse) {
    if let Some(date) = resp.header("Date") {
        if let Some(h) = grain_pdk::http_date_hour_utc(date) {
            let h = ((h + 9) % 24) as i32;
            CACHED_H.with(|c| c.set(if h == 0 { 24 } else { h }));
        }
    }
}

fn map_list(v: Value) -> Value {
    let empty = Vec::new();
    let list = v.get("list").and_then(|x| x.as_array()).unwrap_or(&empty);
    let items: Vec<Value> = list
        .iter()
        .filter_map(|e| {
            let title = e.get("vod_name")?.as_str()?;
            let id = match e.get("vod_id") {
                Some(Value::Number(n)) => n.to_string(),
                Some(Value::String(s)) => s.clone(),
                _ => return None,
            };
            Some(json!({
                "title": title,
                "url": id,
                "cover": e.get("vod_pic").and_then(|x| x.as_str()).unwrap_or(""),
                "update": e.get("vod_remarks").and_then(|x| x.as_str()).unwrap_or(""),
            }))
        })
        .collect();
    Value::Array(items)
}

async fn do_latest(page: u32) -> Result<Value> {
    let params = match CACHED_H.with(|c| c.get()) {
        h if h > 0 => format!("&pg={}&h={}", page, h),
        _ => format!("&pg={}", page),
    };
    let resp = fetch_vod(&params).await?;
    maybe_cache_h(&resp);
    Ok(map_list(resp.json()?))
}

async fn do_search(kw: &str) -> Result<Value> {
    if kw.trim().is_empty() {
        return do_latest(1).await;
    }
    // ABI v0 的 search 只有 keyword 一个参数，页码固定 1（JS 版的 filter 也一并省略）
    let params = format!("&wd={}&pg=1", grain_pdk::urlencode(kw));
    let resp = fetch_vod(&params).await?;
    Ok(map_list(resp.json()?))
}

/// maccms `vod_play_url` 形如 `第01集$http://a#第02集$http://b`
/// （多播放源以 `$$$` 分隔，这里取第一个源）。
fn parse_play_url(raw: &str) -> Vec<Value> {
    raw.split("$$$")
        .next()
        .unwrap_or("")
        .split('#')
        .filter_map(|item| {
            let item = item.trim();
            if item.is_empty() {
                return None;
            }
            let (title, url) = match item.split_once('$') {
                Some((t, u)) => (t.trim(), u.trim()),
                None => ("", item),
            };
            if url.is_empty() {
                return None;
            }
            Some(json!({ "title": title, "url": url }))
        })
        .enumerate()
        .map(|(i, mut ep)| {
            if ep["title"].as_str().map(|s| s.is_empty()).unwrap_or(true) {
                ep["title"] = json!(format!("第{:02}集", i + 1));
            }
            ep
        })
        .collect()
}

fn map_detail(v: Value, id: &str) -> Value {
    let empty = Vec::new();
    let entry = v
        .get("list")
        .and_then(|x| x.as_array())
        .unwrap_or(&empty)
        .first();
    let get_str = |key: &str| {
        entry
            .and_then(|e| e.get(key))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    };
    let description = match get_str("vod_content") {
        s if !s.trim().is_empty() => s,
        _ => get_str("vod_blurb"),
    };
    let episodes = if entry.is_some() {
        parse_play_url(&get_str("vod_play_url"))
    } else {
        Vec::new()
    };
    let title = match get_str("vod_name") {
        s if !s.is_empty() => s,
        _ => format!("vod {}", id),
    };
    json!({
        "title": title,
        "cover": get_str("vod_pic"),
        "description": description,
        "episodes": episodes,
    })
}

async fn do_detail(id: &str) -> Result<Value> {
    let id = id.trim();
    if id.is_empty() {
        return Err(Error::msg("detail url (vod_id) required"));
    }
    let params = format!("&ids={}", grain_pdk::urlencode(id));
    let resp = fetch_vod(&params).await?;
    Ok(map_detail(resp.json()?, id))
}

async fn do_watch(url: &str) -> Result<Value> {
    let url = url.trim();
    if url.is_empty() {
        return Err(Error::msg("watch url required"));
    }
    // maccms 的播放地址即直链；非 http 开头（如解析页链接）也原样返回。
    Ok(json!({ "url": url }))
}

#[plugin_fn]
pub async fn latest(page: u32) -> Result<Value> {
    do_latest(page).await
}

#[plugin_fn]
pub async fn search(keyword: String) -> Result<Value> {
    do_search(&keyword).await
}

#[plugin_fn]
pub async fn detail(url: String) -> Result<Value> {
    do_detail(&url).await
}

#[plugin_fn]
pub async fn watch(url: String) -> Result<Value> {
    do_watch(&url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn play_url_parses_episodes() {
        let eps = parse_play_url(
            "第01集$https://cdn.example.com/1.m3u8#第02集$https://cdn.example.com/2.m3u8",
        );
        assert_eq!(eps.len(), 2);
        assert_eq!(eps[0]["title"], "第01集");
        assert_eq!(eps[0]["url"], "https://cdn.example.com/1.m3u8");
        assert_eq!(eps[1]["title"], "第02集");
        assert_eq!(eps[1]["url"], "https://cdn.example.com/2.m3u8");
    }

    #[test]
    fn play_url_falls_back_to_generated_titles() {
        let eps =
            parse_play_url("https://cdn.example.com/a.m3u8#第02集$https://cdn.example.com/b.m3u8");
        assert_eq!(eps.len(), 2);
        assert_eq!(eps[0]["title"], "第01集");
        assert_eq!(eps[1]["title"], "第02集");
    }

    #[test]
    fn play_url_takes_first_source() {
        let eps = parse_play_url("第01集$a#第02集$b$$$第01集$c");
        assert_eq!(eps.len(), 2);
        assert_eq!(eps[1]["url"], "b");
    }

    #[test]
    fn detail_maps_maccms_entry() {
        let v = json!({"list": [{
            "vod_id": 1001,
            "vod_name": "示例剧",
            "vod_pic": "https://img.example.com/1.jpg",
            "vod_blurb": "简介",
            "vod_play_url": "第01集$https://cdn.example.com/1.m3u8",
        }]});
        let d = map_detail(v, "1001");
        assert_eq!(d["title"], "示例剧");
        assert_eq!(d["description"], "简介");
        assert_eq!(d["episodes"].as_array().unwrap().len(), 1);
    }
}
