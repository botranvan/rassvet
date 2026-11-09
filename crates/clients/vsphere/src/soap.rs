//! The few vim25 SOAP calls Rassvet needs: what the endpoint is (`RetrieveServiceContent`,
//! needs no session) and sign-in / sign-out with `SessionManager` for standalone ESXi hosts,
//! which have no Automation REST API.

use reqwest::{StatusCode, header};

use crate::{About, Error, Result};

/// Cookie holding the SOAP session.
pub const SOAP_COOKIE: &str = "vmware_soap_session";

fn envelope(body: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:vim25"><soapenv:Body>{body}</soapenv:Body></soapenv:Envelope>"#
    )
}

/// POST one SOAP call to `<base>/sdk`. Faults become errors: a refused login is
/// [`Error::Unauthorized`].
pub(crate) async fn call(
    http: &reqwest::Client,
    base: &str,
    cookie: Option<&str>,
    body: &str,
) -> Result<(reqwest::header::HeaderMap, String)> {
    let mut req = http
        .post(format!("{base}/sdk"))
        .header(header::CONTENT_TYPE, "text/xml; charset=utf-8")
        .header("SOAPAction", "urn:vim25/8.0.0.0")
        .body(envelope(body));
    if let Some(c) = cookie {
        req = req.header(header::COOKIE, format!("{SOAP_COOKIE}={c}"));
    }
    let resp = req.send().await?;
    let status = resp.status();
    let headers = resp.headers().clone();
    let text = resp.text().await?;
    if status.is_success() {
        return Ok((headers, text));
    }
    let fault = text_of(&text, "faultstring").unwrap_or_else(|| {
        status
            .canonical_reason()
            .unwrap_or("SOAP request failed")
            .to_owned()
    });
    Err(
        if status == StatusCode::UNAUTHORIZED
            || text.contains("InvalidLogin")
            || text.contains("NotAuthenticated")
        {
            Error::Unauthorized(fault)
        } else {
            Error::Api {
                status,
                message: fault,
            }
        },
    )
}

/// The ServiceContent fields Rassvet uses.
pub(crate) struct ServiceContent {
    pub about: About,
    pub session_manager: String,
}

pub(crate) async fn service_content(http: &reqwest::Client, base: &str) -> Result<ServiceContent> {
    let (_, xml) = call(
        http,
        base,
        None,
        r#"<urn:RetrieveServiceContent><urn:_this type="ServiceInstance">ServiceInstance</urn:_this></urn:RetrieveServiceContent>"#,
    )
    .await?;
    let about_xml = text_of(&xml, "about")
        .ok_or_else(|| Error::InvalidResponse("ServiceContent without <about>".into()))?;
    let field = |name: &str| text_of(&about_xml, name).unwrap_or_default();
    Ok(ServiceContent {
        about: About {
            name: field("name"),
            full_name: field("fullName"),
            version: field("version"),
            build: field("build"),
            api_type: field("apiType"),
            api_version: field("apiVersion"),
            instance_uuid: text_of(&about_xml, "instanceUuid"),
        },
        session_manager: text_of(&xml, "sessionManager").ok_or_else(|| {
            Error::InvalidResponse("ServiceContent without sessionManager".into())
        })?,
    })
}

/// `SessionManager.Login`: the SOAP session cookie and the user name as the host knows it.
pub(crate) async fn login(
    http: &reqwest::Client,
    base: &str,
    session_manager: &str,
    username: &str,
    password: &str,
) -> Result<(String, String)> {
    let body = format!(
        r#"<urn:Login><urn:_this type="SessionManager">{}</urn:_this><urn:userName>{}</urn:userName><urn:password>{}</urn:password></urn:Login>"#,
        escape(session_manager),
        escape(username),
        escape(password),
    );
    let (headers, xml) = call(http, base, None, &body).await?;
    let cookie = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(session_cookie)
        .ok_or_else(|| Error::InvalidResponse("login answer without a session cookie".into()))?;
    let user = text_of(&xml, "userName").unwrap_or_else(|| username.to_owned());
    Ok((cookie, user))
}

pub(crate) async fn logout(
    http: &reqwest::Client,
    base: &str,
    session_manager: &str,
    cookie: &str,
) -> Result<()> {
    let body = format!(
        r#"<urn:Logout><urn:_this type="SessionManager">{}</urn:_this></urn:Logout>"#,
        escape(session_manager)
    );
    call(http, base, Some(cookie), &body).await.map(|_| ())
}

/// The value of the SOAP session cookie in a `Set-Cookie` header (quotes kept: the host
/// expects the cookie back exactly as it sent it).
fn session_cookie(set_cookie: &str) -> Option<String> {
    let first = set_cookie.split(';').next()?.trim();
    let (name, value) = first.split_once('=')?;
    (name.trim() == SOAP_COOKIE && !value.is_empty()).then(|| value.to_owned())
}

/// Text content of the first `<tag …>…</tag>` (no namespace prefix), unescaped.
pub(crate) fn text_of(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let mut from = 0;
    while let Some(i) = xml[from..].find(&open) {
        let start = from + i + open.len();
        let rest = &xml[start..];
        // `<tag>` or `<tag attr="…">`, not `<tagOther>`.
        match rest.chars().next() {
            Some('>') | Some(' ') | Some('\t') | Some('\n') | Some('\r') => {}
            Some('/') => return Some(String::new()),
            _ => {
                from = start;
                continue;
            }
        }
        let gt = rest.find('>')?;
        if rest[..gt].ends_with('/') {
            return Some(String::new());
        }
        let body = &rest[gt + 1..];
        let end = body.find(&format!("</{tag}>"))?;
        return Some(unescape(&body[..end]));
    }
    None
}

pub(crate) fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tags_and_cookies() {
        let xml = r#"<returnval><sessionManager type="SessionManager">ha-sessionmgr</sessionManager><about><name>VMware ESXi</name><fullName>VMware ESXi 8.0.3 build-24022510</fullName><nameExtra/></about></returnval>"#;
        assert_eq!(
            text_of(xml, "sessionManager").as_deref(),
            Some("ha-sessionmgr")
        );
        assert_eq!(text_of(xml, "name").as_deref(), Some("VMware ESXi"));
        assert_eq!(text_of(xml, "nameExtra").as_deref(), Some(""));
        assert!(text_of(xml, "missing").is_none());
        assert_eq!(
            session_cookie(r#"vmware_soap_session="52a1"; Path=/; HttpOnly; Secure;"#).as_deref(),
            Some(r#""52a1""#)
        );
        assert!(session_cookie("other=1; Path=/").is_none());
        assert_eq!(escape("a<b&'c'"), "a&lt;b&amp;&apos;c&apos;");
        assert_eq!(unescape("a&lt;b&amp;c"), "a<b&c");
    }
}
