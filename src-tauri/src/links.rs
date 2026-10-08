//! "Open on <forge>": the forge pages the app opens in the default browser. The webview names
//! the link, so it is checked here first: an `https:` page of a forge the app builds links for,
//! nothing else.

use tauri::Url;

use crate::error::{codes, AppError};

/// The forges' hosts: the ones `src/remotes/forgeLinks.ts` builds links for, which the IPC
/// contract test holds alike through the `forge-hosts` fixture.
pub const FORGE_HOSTS: [&str; 6] = [
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "dev.azure.com",
    "codeberg.org",
    "gitea.com",
];

/// Azure DevOps's older hosts, one per organisation: `geo.visualstudio.com`.
pub const AZURE_ORGANISATION_HOST: &str = ".visualstudio.com";

/// Whether `host` is a forge's: one of [`FORGE_HOSTS`], or an Azure DevOps organisation's,
/// whose name is one label of letters, digits and hyphens that starts with a letter or a
/// digit, as the frontend reads it from a remote.
fn is_forge_host(host: &str) -> bool {
    FORGE_HOSTS.contains(&host)
        || host
            .strip_suffix(AZURE_ORGANISATION_HOST)
            .is_some_and(|organisation| {
                organisation
                    .chars()
                    .next()
                    .is_some_and(|first| first.is_ascii_alphanumeric())
                    && organisation
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
}

/// `link` when the app may open it: an `https:` page of a forge's host on the default port,
/// without credentials. Any other link fails with `external.refused`, the link in `detail`.
pub fn checked_link(link: &str) -> Result<Url, AppError> {
    let refused = || {
        AppError::new(codes::EXTERNAL_REFUSED, "The link is not a forge's page").with_detail(link)
    };
    let url = Url::parse(link).map_err(|_| refused())?;
    let forge = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.host_str().is_some_and(is_forge_host);
    if forge {
        Ok(url)
    } else {
        Err(refused())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_the_pages_of_the_forges() {
        for link in [
            "https://github.com/geo/portal/commit/a1b2c3d",
            "https://gitlab.com/geo/maps/portal/-/tree/claude/fix-auth",
            "https://bitbucket.org/geo/portal/src/a1b2c3d/src/tiles.ts#lines-42",
            "https://dev.azure.com/geo/maps/_git/portal?path=/src/tiles.ts",
            "https://geo.visualstudio.com/maps/_git/portal",
            "https://codeberg.org/geo/portal/src/branch/main",
            "https://gitea.com/geo/portal/commit/a1b2c3d",
            // The parser lowers the scheme and the host, and drops the default port.
            "HTTPS://GitHub.com:443/geo/portal",
        ] {
            let url = checked_link(link).unwrap_or_else(|error| panic!("{link}: {error:?}"));
            assert_eq!(url.scheme(), "https");
        }
        assert_eq!(
            checked_link("https://github.com/geo/portal/blob/main/a%20b.ts")
                .expect("forge")
                .as_str(),
            "https://github.com/geo/portal/blob/main/a%20b.ts"
        );
    }

    #[test]
    fn opens_the_link_as_the_parser_spells_it() {
        // A backslash is a slash in an https URL, an encoded dot and full-width letters are
        // the host's own: each is github.com, and the browser gets the parser's spelling.
        for (link, opened) in [
            (
                "https://github.com\\@evil.com/",
                "https://github.com/@evil.com/",
            ),
            ("https://github%2Ecom/geo", "https://github.com/geo"),
            ("https://\u{ff47}ithub.com/geo", "https://github.com/geo"),
            (
                "https://github.com/geo/a b\"<c>",
                "https://github.com/geo/a%20b%22%3Cc%3E",
            ),
        ] {
            let url = checked_link(link).unwrap_or_else(|error| panic!("{link}: {error:?}"));
            assert_eq!(url.as_str(), opened);
        }
        // A look-alike host in Cyrillic is punycode, no forge's.
        let error = checked_link("https://g\u{456}thub.com/geo").expect_err("look-alike");
        assert_eq!(error.code, codes::EXTERNAL_REFUSED);
    }

    #[test]
    fn refuses_every_other_link() {
        for link in [
            "http://github.com/geo/portal",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "mailto:geo@example.com",
            "ms-settings:privacy",
            "ssh://git@github.com/geo/portal.git",
            "https://github.com.example.com/geo",
            "https://example.com/github.com",
            "https://evilgithub.com/geo",
            "https://git.company.com/geo/portal",
            "https://geo@github.com/geo/portal",
            "https://geo:secret@github.com/geo/portal",
            "https://:secret@github.com/geo/portal",
            "https://github.com:8443/geo/portal",
            "https://github.com./geo/portal",
            "https://maps.geo.visualstudio.com/portal",
            "https://visualstudio.com/geo",
            "https://.visualstudio.com/geo",
            "https://-geo.visualstudio.com/portal",
            "https://ge_o.visualstudio.com/portal",
            "https://140.82.112.3/geo/portal",
            "github.com/geo/portal",
            "",
        ] {
            let error = checked_link(link).expect_err(link);
            assert_eq!(error.code, codes::EXTERNAL_REFUSED, "{link}");
            assert_eq!(error.detail.as_deref(), Some(link));
        }
    }
}
