/**
 * SRSL Offline Translation Engine
 * Self-contained: dictionary + engine in one file.
 * Works fully offline. No external dependencies.
 */
(function () {
    'use strict';

    // ── Dictionary ────────────────────────────────────────────────────────────
    var DICT = {
        en: {
            // Sidebar / Dashboard nav
            nav_dashboard: "Dashboard",
            nav_users: "Users",
            nav_teachers: "Teachers",
            nav_students: "Students",
            nav_parents: "Parents",
            nav_classes: "Classes",
            nav_academics: "Academics",
            nav_announcements: "Announcements",
            nav_messages: "Messages",
            nav_settings: "Settings",
            nav_logout: "Log Out",
            nav_attendance: "Attendance",
            nav_courses: "Courses",
            nav_grades: "Grades",
            nav_rankings: "Rankings",
            nav_transcripts: "Transcripts",
            nav_promotions: "Promotions",
            // Public nav
            nav_home: "Home",
            nav_about: "About",
            nav_gallery: "Gallery",
            nav_contact: "Contact",
            nav_login: "Login",
            // Dashboard cards
            welcome_back: "Welcome back",
            welcome_sub: "Empowering excellence in academic management and system administration.",
            academic_session: "Academic Session",
            system_active: "SYSTEM ACTIVE",
            total_enrollment: "Total Enrollment",
            active_scholars: "Active Scholars",
            academic_faculty: "Academic Faculty",
            expert_educators: "Expert Educators",
            community_parents: "Community Parents",
            connected_guardians: "Connected Guardians",
            offboarded: "Offboarded",
            archived_records: "Archived Records",
            gender_diversity: "Gender Diversity",
            male_scholars: "Male Scholars",
            female_scholars: "Female Scholars",
            promotion_rate: "Promotion Rate",
            overall_success: "Overall Success",
            promoted: "PROMOTED",
            retained: "RETAINED",
            performance_index: "Performance Index",
            average_proficiency: "Average Proficiency",
            tests_analyzed: "Tests Analyzed",
            retention: "Retention",
            withdrawn_archive: "Withdrawn Archive",
            audit_records: "Audit Records",
            operational_insights: "Operational Insights",
            view_history: "View Full History",
            admin_event: "Administrative Event",
            timestamp: "Timestamp",
            outcome: "Outcome",
            verified: "VERIFIED",
            direct_command: "Direct Command",
            enroll_student: "Enroll Student",
            recruit_faculty: "Recruit Faculty",
            add_guardian: "Add Guardian",
            broadcast: "Broadcast",
            issue_certificates: "Issue Certificates",
            system_pulse: "System Pulse",
            real_time: "REAL-TIME",
            programs: "Programs",
            active_courses: "Active Courses",
            success: "Success",
            live_enrollments: "Live Enrollments",
            access_analytics: "ACCESS DATA ANALYTICS",
            no_activities: "No recent activities found",
            // Landing page
            welcome_title: "Welcome to Abdigudina Elementary School",
            hero_subtitle: "Empowering Education Through Modern Technology",
            get_started: "Get Started",
            learn_more: "Learn More",
            powerful_features: "Powerful Features",
            features_subtitle: "Everything you need for modern education management packed into one beautiful, intelligent interface.",
            student_portal: "Student Portal",
            teacher_dashboard: "Teacher Dashboard",
            analytics_engine: "Analytics Engine",
            secure_platform: "Secure Platform",
            mobile_responsive: "Mobile Responsive",
            easy_config: "Easy Configuration",
            // Contact Page
            contact_hero_eyebrow: "We'd love to hear from you",
            contact_hero_title: "Let's start a conversation.",
            contact_hero_subtitle: "Questions, ideas, or need a hand? Our school community is here to help you find the right way forward.",
            contact_hero_btn: "Send us a message",
            contact_hero_link: "Email the school",
            contact_hero_loc: "JiT Campus",
            contact_hero_city: "Jimma, Ethiopia",
            contact_bento_kicker: "Here when you need us",
            contact_bento_title: "The details, made simple.",
            contact_bento_loc_title: "Our Campus Location",
            contact_bento_hours_title: "Support Hours",
            contact_bento_comms_title: "JiT Support",
            contact_bento_comms_desc: "Support specifically for students and staff at Jimma University JiT.",
            contact_mon_fri: "Mon - Fri",
            contact_sat: "Saturday",
            contact_sun: "Sunday",
            contact_closed: "Closed",
            contact_email_us: "Email Us",
            contact_call_us: "Call Us",
            contact_map_kicker: "Visit our campus",
            contact_map_title: "Find us in Jimma.",
            contact_aside_kicker: "A real person will reply",
            contact_aside_title: "Tell us what’s on your mind.",
            contact_aside_text: "Share a little about what you need, and the right person on our team will get back to you.",
            contact_aside_note: "Our support team is available Monday through Saturday.",
            contact_form_kicker: "Contact form",
            contact_form_title: "Send us a message",
            contact_first_name: "First Name",
            contact_last_name: "Last Name",
            contact_email: "Email Address",
            contact_subject: "Subject",
            contact_message: "Your Message",
            contact_send_btn: "Send message"
        },
        am: {
            nav_dashboard: "ዳሽቦርድ",
            nav_users: "ተጠቃሚዎች",
            nav_teachers: "መምህራን",
            nav_students: "ተማሪዎች",
            nav_parents: "ወላጆች",
            nav_classes: "ክፍሎች",
            nav_academics: "አካዳሚክስ",
            nav_announcements: "ማስታወቂያዎች",
            nav_messages: "መልእክቶች",
            nav_settings: "ቅንብሮች",
            nav_logout: "ውጣ",
            nav_attendance: "መገኘት",
            nav_courses: "ኮርሶች",
            nav_grades: "ውጤቶች",
            nav_rankings: "ደረጃዎች",
            nav_transcripts: "ትራንስክሪፕት",
            nav_promotions: "ማለፍ",
            nav_home: "ዋና ገፅ",
            nav_about: "ስለ እኛ",
            nav_gallery: "ማዕከለ ስዕላት",
            nav_contact: "አግኙን",
            nav_login: "ግባ",
            welcome_back: "እንኳን ደህና መጡ",
            welcome_sub: "በአካዳሚክ አስተዳደር እና በስርዓት አስተዳደር ውስጥ የላቀነትን ማበረታታት።",
            academic_session: "የአካዳሚክ ክፍለ ጊዜ",
            system_active: "ስርዓቱ ንቁ ነው",
            total_enrollment: "አጠቃላይ ምዝገባ",
            active_scholars: "ንቁ ተማሪዎች",
            academic_faculty: "የአካዳሚክ ፋኩልቲ",
            expert_educators: "ባለሙያ መምህራን",
            community_parents: "የማህበረሰብ ወላጆች",
            connected_guardians: "የተገናኙ አሳዳጊዎች",
            offboarded: "የተሰናበቱ",
            archived_records: "የተቀመጡ መዝገቦች",
            gender_diversity: "የጾታ ስብጥር",
            male_scholars: "ወንድ ተማሪዎች",
            female_scholars: "ሴት ተማሪዎች",
            promotion_rate: "የማለፊያ መጠን",
            overall_success: "አጠቃላይ ስኬት",
            promoted: "ያለፉ",
            retained: "የደገሙ",
            performance_index: "የአፈጻጸም መረጃ ጠቋሚ",
            average_proficiency: "አማካይ ብቃት",
            tests_analyzed: "የተተነተኑ ፈተናዎች",
            retention: "ማቆየት",
            withdrawn_archive: "ያቋረጡ ማህደር",
            audit_records: "መዝገቦችን ይገምግሙ",
            operational_insights: "ተግባራዊ ግንዛቤዎች",
            view_history: "ሙሉ ታሪክ ይመልከቱ",
            admin_event: "የአስተዳደር ክስተት",
            timestamp: "የጊዜ ማህተም",
            outcome: "ውጤት",
            verified: "የተረጋገጠ",
            direct_command: "ቀጥተኛ ትዕዛዝ",
            enroll_student: "ተማሪ መዝግብ",
            recruit_faculty: "መምህር ቅጠር",
            add_guardian: "አሳዳጊ አክል",
            broadcast: "አሰራጭ",
            issue_certificates: "የምስክር ወረቀት ስጥ",
            system_pulse: "የስርዓት ሁኔታ",
            real_time: "በእውነተኛ ጊዜ",
            programs: "ፕሮግራሞች",
            active_courses: "ንቁ ኮርሶች",
            success: "ስኬት",
            live_enrollments: "ቀጥታ ምዝገባዎች",
            access_analytics: "የውሂብ ትንታኔዎችን ይድረሱ",
            no_activities: "ምንም የቅርብ ጊዜ እንቅስቃሴዎች አልተገኙም",
            welcome_title: "ወደ አብዲጉዲና የመጀመሪያ ደረጃ ትምህርት ቤት እንኳን በደህና መጡ",
            hero_subtitle: "ትምህርትን በዘመናዊ ቴክኖሎጂ ማሳደግ",
            get_started: "ይጀምሩ",
            learn_more: "ተጨማሪ ይወቁ",
            powerful_features: "ኃይለኛ ባህሪዎች",
            features_subtitle: "ለዘመናዊ የትምህርት አስተዳደር የሚፈልጉት ነገር ሁሉ በአንድ ውብ እና ብልህ በይነገጽ ውስጥ ቀርቧል።",
            student_portal: "የተማሪ ፖርታል",
            teacher_dashboard: "የመምህር ዳሽቦርድ",
            analytics_engine: "የትንታኔ ሞተር",
            secure_platform: "ደህንነቱ የተጠበቀ መድረክ",
            mobile_responsive: "በሞባይል የሚሰራ",
            easy_config: "ቀላል አዋቅር",
            // Contact Page
            contact_hero_eyebrow: "ከእርስዎ መስማት እንፈልጋለን",
            contact_hero_title: "ውይይት እንጀምር።",
            contact_hero_subtitle: "ጥያቄዎች፣ ሃሳቦች ወይስ እገዛ ይፈልጋሉ? የትምህርት ቤታችን ማህበረሰብ ትክክለኛውን መንገድ እንዲያገኙ ሊረዳዎት ዝግጁ ነው።",
            contact_hero_btn: "መልእክት ይላኩልን",
            contact_hero_link: "ለትምህርት ቤቱ ኢሜይል ይላኩ",
            contact_hero_loc: "ጂአይቲ ካምፓስ",
            contact_hero_city: "ጅማ፣ ኢትዮጵያ",
            contact_bento_kicker: "ሲፈልጉን ሁሌም ዝግጁ ነን",
            contact_bento_title: "መረጃዎች፣ በቀላሉ የቀረቡ።",
            contact_bento_loc_title: "የትምህርት ቤታችን አድራሻ",
            contact_bento_hours_title: "የድጋፍ ሰዓታት",
            contact_bento_comms_title: "የጂአይቲ ድጋፍ",
            contact_bento_comms_desc: "በተለይ ለጅማ ዩኒቨርሲቲ ጂአይቲ ተማሪዎች እና ሰራተኞች የተዘጋጀ ድጋፍ።",
            contact_mon_fri: "ከሰኞ - አርብ",
            contact_sat: "ቅዳሜ",
            contact_sun: "እሑድ",
            contact_closed: "ዝግ ነው",
            contact_email_us: "ኢሜይል ይላኩ",
            contact_call_us: "ይደውሉልን",
            contact_map_kicker: "ካምፓሳችንን ይጎብኙ",
            contact_map_title: "በጅማ ያግኙን።",
            contact_aside_kicker: "ባለሙያዎቻችን ፈጣን ምላሽ ይሰጣሉ",
            contact_aside_title: "የሚያሳስብዎትን ያካፍሉን።",
            contact_aside_text: "የሚፈልጉትን አጭር መረጃ ያጋሩን፣ ከቡድናችን ተገቢው ባለሙያ ያነጋግርዎታል።",
            contact_aside_note: "የድጋፍ ቡድናችን ከሰኞ እስከ ቅዳሜ ዝግጁ ነው።",
            contact_form_kicker: "የመገናኛ ቅጽ",
            contact_form_title: "መልእክት ይላኩልን",
            contact_first_name: "የመጀመሪያ ስም",
            contact_last_name: "የአባት ስም",
            contact_email: "የኢሜይል አድራሻ",
            contact_subject: "ጉዳዩ",
            contact_message: "መልእክትዎ",
            contact_send_btn: "መልእክት ላክ"
        },
        om: {
            nav_dashboard: "Daashboordii",
            nav_users: "Fayyadamtota",
            nav_teachers: "Barsiisota",
            nav_students: "Barattoota",
            nav_parents: "Maatii",
            nav_classes: "Kutaalee",
            nav_academics: "Akkaadaamii",
            nav_announcements: "Beeksisa",
            nav_messages: "Ergaawwan",
            nav_settings: "Qindaa'inoota",
            nav_logout: "Bahi",
            nav_attendance: "Hirmaannaa",
            nav_courses: "Koorsiiwwan",
            nav_grades: "Qabxiiwwan",
            nav_rankings: "Sadarkaa",
            nav_transcripts: "Tiraanskiriiptii",
            nav_promotions: "Darbiinsa",
            nav_home: "Fuula Duraa",
            nav_about: "Waa'ee keenya",
            nav_gallery: "Kuusaa Suuraa",
            nav_contact: "Nu Quunnamaa",
            nav_login: "Seeni",
            welcome_back: "Baga nagaan dhuftan",
            welcome_sub: "Bulchiinsa akkaadaamii fi sirna keessatti gahumsa guddisuu.",
            academic_session: "Bara Barnootaa",
            system_active: "SIRNI HOJJETAA JIRA",
            total_enrollment: "Galmee Waliigalaa",
            active_scholars: "Barattoota Hojjetaa",
            academic_faculty: "Fakaltee Akkaadaamii",
            expert_educators: "Barsiisota Ogeeyyii",
            community_parents: "Maatii Hawaasaa",
            connected_guardians: "Guddiftota Wal-qunnaman",
            offboarded: "Gadi Dhiisan",
            archived_records: "Galmeewwan Kuufaman",
            gender_diversity: "Garaagarummaa Saalaa",
            male_scholars: "Barattoota Dhiiraa",
            female_scholars: "Barattoota Dubaraa",
            promotion_rate: "Safartuu Darbiinsaa",
            overall_success: "Milkaa'ina Waliigalaa",
            promoted: "DARBAN",
            retained: "HAFAN",
            performance_index: "Agarsiiftuu Raawwii",
            average_proficiency: "Giddugaleessa Gahumsaa",
            tests_analyzed: "Qormaata Xiinxalaman",
            retention: "Tursiisa",
            withdrawn_archive: "Kuusaa Addaan Kutan",
            audit_records: "Galmeewwan Mirkaneessi",
            operational_insights: "Hubannoo Hojii",
            view_history: "Seenaa Guutuu Ilaali",
            admin_event: "Taatee Bulchiinsaa",
            timestamp: "Yeroo",
            outcome: "Bu'aa",
            verified: "MIRKANAA'EE JIRA",
            direct_command: "Ajaja Kallattii",
            enroll_student: "Barataa Galmeessi",
            recruit_faculty: "Barsiisaa Qacari",
            add_guardian: "Guddifataa Ida'i",
            broadcast: "Tamsaasi",
            issue_certificates: "Waraqaa Ragaa Kenni",
            system_pulse: "Haala Sirnaa",
            real_time: "YEROO QABATAMAA",
            programs: "Sagantaalee",
            active_courses: "Koorsiiwwan Hojjetaa Jiran",
            success: "Milkaa'ina",
            live_enrollments: "Galmeewwan Kallattii",
            access_analytics: "XIINXALA DAATAA ARGACHI",
            no_activities: "Sochiileen dhihootti hin argamne",
            welcome_title: "Baga nagaan gara Mana Barumsaa Sadarkaa Tokkoffaa Abdiiguddinaa dhuftan",
            hero_subtitle: "Barnoota Teeknooloojii Ammayyaatiin Guddisuu",
            get_started: "Eegali",
            learn_more: "Dabalata Dubbisi",
            powerful_features: "Amaloota Guguddoo",
            features_subtitle: "Waan barnoota ammayyaa bulchuuf barbaaddan hundi haala bareedaa fi salphaa ta'een dhiyaateera.",
            student_portal: "Bortaalii Barattootaa",
            teacher_dashboard: "Daashboordii Barsiisotaa",
            analytics_engine: "Kutaalee Xiinxalaa",
            secure_platform: "Waltajjii Nageenyummaa qabu",
            mobile_responsive: "Moobaayilaaf Mijataa",
            easy_config: "Qindaa'ina Salphaa",
            // Contact Page
            contact_hero_eyebrow: "Yaada keessan dhagahuu barbaanna",
            contact_hero_title: "Marii haa eegallu.",
            contact_hero_subtitle: "Gaaffii, yaada moo gargaarsa barbaaddu? Hawaasni manneen barnootaa keenya karaa sirrii akka argattuuf si gargaaruuf as jira.",
            contact_hero_btn: "Ergaa nuuf ergaa",
            contact_hero_link: "Mana barumsaaf Imeelii ergaa",
            contact_hero_loc: "Kaampaasii JiT",
            contact_hero_city: "Jimma, Itoophiyaa",
            contact_bento_kicker: "Yeroo nu barbaaddan as jirra",
            contact_bento_title: "Odeeffannoo, salphaatti dhiyaate.",
            contact_bento_loc_title: "Teessoo Kaampaasii Keenyaa",
            contact_bento_hours_title: "Sa'aatii Deeggarsaa",
            contact_bento_comms_title: "Deeggarsa JiT",
            contact_bento_comms_desc: "Deeggarsa addatti barattootaa fi hojjettoota Yuunivarsiitii Jimmaa JiT tiif qophaa'e.",
            contact_mon_fri: "Wiixata - Jimaata",
            contact_sat: "Sanbata",
            contact_sun: "Dilbata",
            contact_closed: "Cufaadha",
            contact_email_us: "Imeelii Ergaa",
            contact_call_us: "Nuuf Bilbilaa",
            contact_map_kicker: "Kaampaasii keenya daawwadhaa",
            contact_map_title: "Jimma keessatti nu argadhaa.",
            contact_aside_kicker: "Namni sirriin deebii kenna",
            contact_aside_title: "Wanta yaaddan nuuf qoodaa.",
            contact_aside_text: "Waan barbaaddan gabaabinaan nuuf himaa, ogeessi sirriin garee keenyaa deebii isiniif kenna.",
            contact_aside_note: "Gareen gargaarsa keenya Wiixata hanga Sanbataatti qophiidha.",
            contact_form_kicker: "Foormii Qunnamtii",
            contact_form_title: "Ergaa nuuf ergaa",
            contact_first_name: "Maqaa Duraa",
            contact_last_name: "Maqaa Abbaa",
            contact_email: "Teessoo Imeelii",
            contact_subject: "Dhimma",
            contact_message: "Ergaa Keessan",
            contact_send_btn: "Ergaa ergi"
        }
    };

    // Mapping of language codes to display labels for the language button
    var LANG_LABELS = {
        en: 'English',
        am: 'አማርኛ',
        om: 'Afan Oromo'
    };

    // ── Engine ─────────────────────────────────────────────────────────────────
    function applyTranslations(lang) {
        if (!DICT[lang]) return;

        // Update <html lang="...">
        document.documentElement.lang = lang;

        // Update all visible lang labels
        var labels = document.querySelectorAll('#currentLangLabel, .current-lang-label');
        for (var i = 0; i < labels.length; i++) {
            // Use human‑readable language name if available
            labels[i].textContent = (LANG_LABELS[lang] || lang.toUpperCase());
        }

        // Update dashboard <select>
        var sel = document.getElementById('languageSelector');
        if (sel) sel.value = lang;

        // Translate every [data-key] element
        var elements = document.querySelectorAll('[data-key]');
        for (var j = 0; j < elements.length; j++) {
            var el = elements[j];
            var key = el.getAttribute('data-key');
            var text = DICT[lang][key];
            if (text) {
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                    el.placeholder = text;
                } else {
                    el.textContent = text;
                }
            }
        }

        // Translate every [data-key-placeholder] element
        var placeholderElements = document.querySelectorAll('[data-key-placeholder]');
        for (var k = 0; k < placeholderElements.length; k++) {
            var pEl = placeholderElements[k];
            var pKey = pEl.getAttribute('data-key-placeholder');
            var pText = DICT[lang][pKey];
            if (pText) pEl.placeholder = pText;
        }
    }

    function changeLanguage(lang) {
        if (!DICT[lang]) return;
        localStorage.setItem('srsl_lang', lang);

        // Fade out
        document.body.style.transition = 'opacity 0.15s';
        document.body.style.opacity = '0.6';

        setTimeout(function () {
            applyTranslations(lang);
            document.body.style.opacity = '1';
        }, 150);
    }

    // ── Wire up events when DOM is ready ──────────────────────────────────────
    function init() {
        var savedLang = localStorage.getItem('srsl_lang') || 'en';

        // Apply saved language immediately on load
        applyTranslations(savedLang);

        // Dashboard <select> element
        var sel = document.getElementById('languageSelector');
        if (sel) {
            sel.value = savedLang;
            sel.addEventListener('change', function (e) {
                changeLanguage(e.target.value);
            });
        }

        // ── Click handler ──
        // Uses capture=true so it fires BEFORE Bootstrap closes the dropdown.
        // Uses closest() to handle clicks on child elements inside the <a>.
        document.addEventListener('click', function (e) {
            var el = e.target;
            // Walk up max 3 levels to find .lang-switch
            for (var i = 0; i < 3; i++) {
                if (!el) break;
                if (el.classList && el.classList.contains('lang-switch')) {
                    e.preventDefault();
                    var lang = el.getAttribute('data-lang');
                    if (lang) changeLanguage(lang);
                    return;
                }
                el = el.parentElement;
            }
        }, true); // ← CAPTURE PHASE — runs before Bootstrap
    }

    // ── Expose globally (for console debugging) ───────────────────────────────
    window.translations = DICT;
    window.switchLanguage = changeLanguage;

    // Run as soon as DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
