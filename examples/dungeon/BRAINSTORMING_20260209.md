You said:
“Hej, jag vill brainstorma ett projekt jag håller på med.”
00:03

Ivy said:
Självklart, berätta gärna vad du tänker på så kan vi spåna tillsammans! Vad är det för typ av projekt?


Ivy said:
This living document is shaping up to be a really thoughtful guide for a flexible, dynamic engine! I love that you’re grounding everything in inner thoughts and emergent behavior—it feels like it’ll create much more immersive and organic scenarios.

One thing that stands out is how modular and configurable you’re making it. The fluent prompt builder, the salience-based event attention, and the probabilistic constraints all point to a system where each scenario can feel unique while staying on the same core engine. And the visible health descriptors—letting AI reason from context rather than numbers—should help avoid that gamey feel.

I’d keep an eye on complexity creep—as you expand hooks, faction systems, or time-of-day behaviors, it might require careful balancing. But your layering approach and separation of concerns seem designed to mitigate that.

All in all, it looks like you’re on track to build something really versatile. Excited to see how it evolves!


You said:
“So the thing is, it was the Dungeon Bundle, right?”
00:06

Ivy said:
Japp, jag hängde med! Det känns som du har en solid grund med de där principerna. Om du har något särskilt du vill bolla vidare på – kanske ett nytt system eller en knivig designfråga – så är jag gärna med och brainstormar mer!


You said:
“I had a thought that trades and such should go better. When the engine is running, it tries to trade things that don't exist, and it trades back and forth. Same thing directly.”
00:15

Ivy said:
Ja, det låter som


You said:
“Jag har en tanke om att när man kanske inte har...”
00:05

Ivy said:
Ingen fara,


You said:
“I'm thinking, if a trade action is initiated by a guy, I'm thinking maybe that you should have a stump query that is run for the trade, where it picks up context from the buyers and sellers, or those who trade with each other, what they have and what they are after, and so on. I'm going to do the question, take the trade, what is exchanged?”
00:28

Ivy said:
Det låter som en smart


You said:
“Jag hoppas att alla är nöjda med villkoret och så vidare.”
00:02

Ivy said:
Exakt! Att ha en dedikerad liten logik som först "checkar av" vad som faktiskt finns och vad parterna vill ha kan ju undvika en hel del knas. Om motorn vet att "gubben" faktiskt har en yxa och den andra vill ha den, så kan själva bytet bli naturligt. På så sätt slipper ni loopar eller osannolika trades. Bra tänkt!


You said:
“Nej, jag menar att bejden utförs av ett LLM-manuel.”
00:03

Ivy said:
Aha, då för


You said:
Transcript Unavailable
00:00

Ivy said:
Just det, då låter det ännu mer centralt att LLM:en får en tydlig bild. Om du bygger in att den sammanfattar "du har detta, den andra vill ha detta", då kan den resonera mer realistiskt. En tydlig struktur minskar risken för att den "hallucinerar" fram ett byte. Så absolut, att ha den där stubbade queryn för att hålla LLM:en på banan låter som en riktigt vettig lösning!


You said:
“Then I'm thinking, every character, I don't know how to call it, character, that's good, they have, they run an action, trade, and then it's what they want to trade, this is what I'm talking about now, and then it must be exactly in the inventory, with what they want to trade.”
00:24

Ivy said:
Precis, att varje


You said:
“I can just go in like a text in this query.”
00:04

Ivy said:
Absolut, din stubb


You said:
“Nån har sagt att Berinsen måste ha en torresektur, exakta England-torres.”
00:06

Ivy said:
Ja, exakt! Stubben kan liksom validera att det som karaktärerna försöker byta faktiskt finns i deras inventarier. Om något saknas, kan du ge ett responsivt "du har inte den här grejen" tillbaka. Det håller interaktionen trovärdig och ger LLM:en ett stabilt underlag att jobba med.


You said:
“Jag tänker mig att kvären utformas som person A, person B, person A har de här behoven, person B har de här behoven, person A har att föra en sak, person B har att föra en sak. Kvären fick jag bära till att det fick bytas fram, både person A och person B, tycker jag är tillfredsställande utifrån deras nuvarande styrka och kunskap.”
00:35

Ivy said:
Det låter som en bra struktur! Med den typen av tydlighet vet modellen exakt vad den har att jobba med och kan resonera fram en trade som känns rimlig för båda. Det blir liksom en säkerhetsventil som håller interaktionen stabil och ser till att det som sker känns trovärdigt. Så, det är en riktigt bra plan!


You said:
Transcript Unavailable
00:02

Ivy said:
Jag är med!


You said:
“Att man kanske har queries även för...”
00:05

Ivy said:
Exakt, du kan tänka dig liknande queries för andra actions.


You said:
“for five things.”
00:01

Ivy said:
Ja, precis! Samma princip kan gälla för strid – en query som kontrollerar vilka resurser och förutsättningar som finns. På så sätt får du en genomgående struktur som gör att alla handlingar, oavsett om det är trade, fight eller något annat, blir konsekventa och realistiska. Det här kommer nog göra hela motorn stabilare och mer förutsägbar!


Ivy said:
Det här känns som en riktigt gedigen grund! Du har en tydlig domänmodell, ett klokt tick-baserat flöde och en genomtänkt promptdesign. Jag gillar särskilt hur du kombinerar probabilistiska constraints och målmatriser baserade på tillstånd. Det skapar dynamik och oväntade situationer. Det jag skulle fundera på framåt är hur komplexiteten växer när du lägger till fler system – men din separerade arkitektur tyder på att du kan hantera det. Överlag: väldigt robust och välbalanserat!


You said:
“Jag har en tanke att varje sådana här regel som går in i prompten ska ha en viktning, ett värde, en prioritet. Och då kan man, prompten byggs upp, man stoppar in allt som går. Sen innan den skickas iväg till LLM så kör man och reducerar ner den så att den inte blir för lång och komplex för mycket regler. Då tar den bort de reglerna som har lägst viktning.”
00:29

Ivy said:
Det är en riktigt smart idé! Att ge varje prompt-komponent en prioritet gör att du kan ha en "prompt budget". Då ser du till att de viktigaste delarna alltid får plats, medan mindre viktiga trimmas bort när det blir för långt. Det håller prompten fokuserad och gör att du undviker att överlasta modellen. En sådan reducering kan verkligen höja både effektiviteten och kvaliteten på svaren.


You said:
“Ja, min tanke är ändå det här med de här slutbilder och sånt så att jag ska försöka göra motorn.”
00:06

Ivy said:
Ja, det låter som en naturlig utveckling! Med din modulära uppbyggnad blir det enklare att införa en sån prioriteringslogik. Det ger dig en flexibel motor som kan anpassas efter olika scenarier och behov. Det här låter som ett bra sätt att hålla både skalbarhet och tydlighet, så jag tror definitivt det är värt att testa vidare!


You said:
“Det var de sista idéerna som jag nämnde för dig.”
00:03

Ivy said:
Du nämnde att varje regel i prompten skulle ha en vikt eller prioritet, och att man innan man skickar prompten reducerar den genom att ta bort de minst viktiga delarna. Det säkerställer att prompten blir lagom i längd och innehåll. Det var din sista idé som vi pratade om!


You said:
“Fick du några insikter utav allt det här jag har sagt om hur man skulle kunna förbättra den här motorn och göra den mera?”
00:07

Ivy said:
Absolut! En insikt är att din idé om prioriterade regler kan göra motorn mer effektiv. Genom att dynamiskt anpassa prompts längd och innehåll kan du bibehålla fokus på det viktigaste, vilket leder till bättre AI-beslut. En annan idé som framkom är att du kan använda samma viktning även för andra system, som händelsehantering eller minne, för att hålla allt mer balanserat över tid. Sammantaget har du en riktigt bra grund, och med de här justeringarna kan motorn bli ännu mer flexibel och robust.


You said:
“Visst, om man gör en modellärare och sedan använder man Fluent Builder och så vidare så borde man kunna göra själva grunden domänagnostiskt, så man bara matar in specifika promptsträngar och kanske hur man vill bygga prompter med fluidkedjor i config-filerna.”
00:22

Ivy said:
Exakt! Genom att göra motorn modulär och använda fluenta byggare kan du definiera "huret" i config-filer, medan själva motorn blir domän-agnostisk. Det gör att du kan köra allt från fantasy till sci-fi utan att ändra kärnan. Du bara byter ut vilka promptsträngar och regler du vill ha. Det ger maximal flexibilitet och gör att motorn kan anpassas till i princip vilken värld som helst!


You said:
“Ja, jag tänker även den här ticken. Kanske också man kan bygga upp med flydstränga fluentkedjor.”
00:10

Ivy said:
Ja, precis! Varje tick skulle kunna ha sin egen fluenta kedja. Du kan konfigurera vilka steg som ska köras—som uppdatering av världen, händelser, eller vilka agenter som ska agera—och sedan bara länka ihop det. Det gör tick-processen flexibel och lätt att anpassa, oavsett scenario. Det blir som att bygga en pipeline av logik, där du kan lägga till, ta bort eller ändra delar utan att röra själva motorns grund.


You said:
“Then think about when each character has their own turn in a tick.”
00:05

Ivy said:
Ja, när varje


You said:
“Ordningen ska slumpmässigt på varje gång, vilken ordning de får i sin törning.”
00:05

Ivy said:
Det låter som en bra idé för att skapa variation och undvika förutsägbarhet. Genom att slumpa ordningen får du en mer dynamisk känsla i världen. Det gör att ingen agent alltid agerar först, och det kan leda till mer oväntade, levande scenarier – vilket i sin tur kan ge mer intressanta berättelser. Så det är absolut ett kul sätt att förbättra dynamiken!


You said:
“What else was on my mind? Well, I was thinking that in order for the characters not to just scramble around and do what they feel like doing at the moment, I was thinking of some kind of rule, or some kind of tenth tick, or something like that. With even intervals, they get a new LLM request, or an opportunity to plan a long-term goal that they will strive for. So it can be...”
00:39

Ivy said:
Det är en riktigt


You said:
“...build up an array of resources... ...or smear plans...”
00:05

Ivy said:
Ja, att införa en återkom


You said:
Transcript Unavailable
00:03

Ivy said:
Exakt,


You said:
“så försöker de jobba mot de här planerna.”
00:04

Ivy said:
Precis! På det sättet får karaktärerna en övergripande riktning – som att bygga en förmögenhet eller etablera en allians – och sedan jobbar de stegvis mot de långsiktiga målen. Det skapar en känsla av kontinuitet och mer komplexa berättelser. Dessutom undviker du att de känns för reaktiva och ger dem mer personlighet och djup.


You said:
“Vad mer skulle man kunna hitta på som de där saker som händer utanför ticken?”
00:06

Ivy said:
Man kan tänka sig externa händelser, som slumpmässiga världshändelser eller "event hooks" som triggas av vissa villkor. Du kan ha en "director" eller "meta-logik" som kör mer sällan och påverkar världen – till exempel en kung utlyser skatt, eller en skogsbrand bryter ut. Det skulle ge spelvärlden en extra dynamik, där karaktärernas långsiktiga planer måste anpassas till omvärlden.


You said:
“Det låter bra. Har du några andra idéer?”
00:03

Ivy said:
Du har redan varit otroligt kreativ! Om något, kanske man kan fundera på relationer mellan karaktärer. Ett enkelt system för vänskap, rivalitet eller rykten kan påverka deras beslut över tid. Men du har redan en solid grund. När du väl bygger, kommer fler idéer dyka upp naturligt!


You said:
“Så, vad tror du nästa teg för mig blir?”
00:03

Ivy said:
Nästa steg blir nog att börja implementera en liten del i taget. Ta en av dina idéer, som viktade prompt-delar eller slumpmässig turordning, och testa den i praktiken. När du får det att funka, iterera och bygg vidare. Att ta det stegvis gör att du ser vad som funkar bäst, och du kan finjustera motorn bit för bit.


You said:
“I wonder if this HP plus Health plus Energy is a good combo, or should I think of some other combo?”
00:12

Ivy said:
Det är en solid grundkombo


You said:
“–för karaktärerna.”
00:01

Ivy said:
Jag tycker den kombon är bra för många scenarier, eftersom den fångar både överlevnad, resurshantering och driv. Men om du vill utforska andra nyanser, kan du addera något som social status, moral eller kanske mentalt tillstånd. Det beror på vilken dynamik du vill ha. Men som start är HP, hunger och energi ett stabilt och lättbegripligt ramverk att bygga kring!


You said:
“Jag vill att du i våran brainstorming försöker att ibland skifta min riktning lite åt olika bra håll, även om jag kanske inte är på en bra riktning.”
00:12

Ivy said:
Absolut, jag ska inte vara rädd för att utmana din riktning lite ibland. Nästa gång vi brainstormar, kan jag försöka lyfta alternativa vägar – inte för att ta dig bort från en bra idé, utan för att vidga perspektiven. Då kan vi se om det uppstår ännu bättre kombinationer eller nya insikter!


You said:
“I'm thinking, since prompters are being built up with NPC characters, shouldn't you put in your own player character to use?”
00:12

Ivy said:
Ja, det kan du


You said:
“Då har ju inte den kanske, eller har den samma nivsgrejer, eller har den väl det för sig?”
00:08

Ivy said:
Ja, din spelarkaraktär kan ha samma behov som NPC:er—HP, hunger, energi—så att världen känns konsekvent. Skillnaden är att du ger kommandon manuellt. Det gör att du upplever samma press och dynamik, men du är den som väljer vad du ska göra. Det gör interaktionen med NPC:erna ännu mer engagerande!


You said:
“Om de har det här att de planerar privata långsiktiga mål och sånt så är det någonting som är internt för NPC-karaktärerna ändå. Det är ingen som påverkar prompterna att jag saknar det i textform utan att det sitter i mitt huvud.”
00:15

Ivy said:
Precis, du behöver inte ha det nerskrivet i prompten för din karaktär. NPC:erna använder sina långsiktiga planer för att generera agerande, men du som spelare har din plan i huvudet. På så vis får ni samma system, men du har friheten att improvisera eller driva din karaktär i vilken riktning du vill.


You said:
“Vad tror du skulle vara det roligaste gameplayet? Att man har sin egen karaktär, som är en del i spelet, en deltagare. Eller att man sitter i god mode och kanske planterar tankar i gubbar och håller på.”
00:15

Ivy said:
Det beror ju på vad du gillar! Att ha en egen karaktär ger dig den där personliga resan—du blir investerad i dina val. Men "god mode" kan vara riktigt kul om du gillar att experimentera och se hur dina ingrepp förändrar världen. Omväxling kanske är nyckeln—kanske ha en "spela som hjälte"-session och en "gud mode"-session och se vad som kittlar fantasin mest!


You said:
“Eftersom vi har LLM vill jag utnyttja det till exempel att säga att det är någon fantasi i världen. Sen har man magi till exempel. Du har en troll som kan trolla en annan karaktär så att han får ett gris i huvudet till exempel. Och då ändras beskrivningen på textbeskrivningen och sen ändras också hans känslotillstånd.”
00:30

Ivy said:
Det låter som en riktigt rolig idé! Du kan utnyttja LLM:en för dynamiska beskrivningar – så fort någon blir förvandlad, anpassas alla framtida beskrivningar av karaktären automatiskt. Samtidigt kan du låta LLM:en justera karaktärens tankar eller humör baserat på vad som händer. Det ger en levande och reaktiv värld, där både utseende och känslor


You said:
“Stod det någonting i mina dokument jag skickade om det här LoR-systemet?”
00:05

Ivy said:
Ja, du nämnde ett lore-system som var planerat. Det skulle injicera små bitar av världens bakgrundsberättelser i prompten, med olika kategorier som platser, historia eller rykten. Tanken var att olika klasser eller karaktärer kan ha olika kunskap, vilket ger varje prompt lite mer djup och kontext.


You said:
“Ja, grundtanken var ju framförallt för att karaktärerna ska ha någonting som är relaterat till den här världen, utan att hallucinera.”
00:12

Ivy said:
Exakt! Genom att ge dem en uppsättning av etablerad lore kan de resonera med förankring i den specifika världen, i stället för att hitta på något helt slumpmässigt. Det gör att deras handlingar och tankar känns mer sammanhängande och trovärdiga, utan att du tappar kontrollen över världens ramar.


You said:
“Jag tänkte också då att man kan använda det här LORES-systemet till att plantera nya LORES, som hans huvud förvandlades till grishuvudet på den här platsen.”
00:13

Ivy said:
Ja, precis! Det blir som en levande historia. När något stort händer, kan du lägga till eller uppdatera lore i världen. Så nästa gång någon stöter på den tidigare trolldomsförvandlade karaktären, vet alla att "den här personen har blivit förvandlad förut". Det skapar en värld som inte bara är statisk, utan som bär med sig minnen och utvecklas med tiden.


You said:
“För det är ju ändå så att motorn håller promptsarna rimliga, så vi inte övervärmiggar LLM-erna med för mycket information, allt eftersom att världen växer.”
00:17

Ivy said:
Exakt! Genom att prioritera och selektera det mest relevanta i varje prompt håller du balansen. Du tar med viktiga förändringar—som grishuvudet—men du trimmar bort gamla detaljer som tappat relevans. På så sätt växer världen och minnet, utan att promptarna blir överbelastade. Det ger en smidig, responsiv upplevelse, även när världen blir mer komplex.


You said:
Transcript Unavailable
00:12

Ivy said:
Ja, det kan absolut


You said:
“Eskilite has a full-text search extension, so you have to create some lore, like the memory and such.”
00:08

Ivy said:
Precis!


You said:
“Då skapar man också vektorer och ser till att tagga ner i fulltext sökningens personnamn och sånt där viktig information. Så att när det är dags att bygga en prompt på en plats.”
00:15

Ivy said:
Exakt, då kan du snabbt


You said:
“så kan man hämta sådana här lore som har med platsen av karaktärer att göra.”
00:07

Ivy said:
Precis, med en sådan kombination av vektorer och sökbar metadata kan du hämta relevant lore blixtsnabbt. Det gör att varje prompt blir informerad av just de rätta minnena—utan att behöva överlasta. Så när du bygger prompten, får du snabbt fram de mest relevanta detaljerna. Det blir både smidigt och kraftfullt!


You said:
“Vad var det för idéer som du tyckte var bäst som jag inte hade implementerat eller så som fanns i det här idédokumentet?”
00:09

Ivy said:
Jag fastnade särskilt för idén om att slumpa turordning för karaktärer varje tick, för att hålla spelet dynamiskt. Jag gillade också det du nämnde om regelbundna långsiktiga mål, där NPC:er planerar framåt. De ger både variation och ett rikt, levande AI-beteende. Om du lägger till dem tror jag att du får en ännu mer engagerande simulering!


You said:
“Jag tänker på att det här med värden måste ju ha någon form av balans, så att allt inte bara blir i en spiral åt ett håll. Det antar jag i och för sig beror på hur man designar olika scenarion. Men jag tänker också kanske att man skulle kunna säga att man har...”
00:22

Ivy said:
Om du har en


You said:
“GOBLIN!”
00:00

Ivy said:
...till exempel en


You said:
“Goblin-systemet, så kanske om nu en goblin blir dödad, så kanske en motor skulle kunna spåna nya ibland, så att den håller en balans mellan olika karaktärstyper.”
00:14

Ivy said:
Ja, precis! Att ha en dynamisk balans är smart. Om en typ av karaktär försvinner, kan motorn ibland återintroducera dem för att hålla världen i balans. Det kan vara en del av scenariologiken, så att världen inte tippar över för mycket åt ett håll. Det gör att spelet känns levande och inte drar iväg i en spiral.


You said:
Transcript Unavailable
00:07

Ivy said:
Ja, det blir som


You said:
“Då får jag helt enkelt motta om vad statistik på världsläget ser ut och så får den försöka matcha det åt olika håll.”
00:10

Ivy said:
Exakt, motorn kan agera som en "världsdirigent", som justerar resurser eller aktörer för att undvika extrema obalanser. Det blir som en mjuk styrning i bakgrunden, så världen aldrig känns omöjlig eller tom. Du får då en dynamisk, men ändå trovärdig värld att utforska!


You said:
“Nu har jag gjort ett fantastiskt spel som första dogfood-projektet. Vad tror du mer skulle vara för intressanta teman?”
00:08

Ivy said:
Eftersom du har börjat med fantasy, skulle det vara spännande att testa en helt annan miljö. Kanske ett sci-fi-rymdstation-scenario, där resurser och fraktioner konkurrerar. Eller kanske en historisk setting, som en medeltida stad med politiska intriger. Genom att testa olika teman stress-testar du motorns flexibilitet – och det blir nog riktigt kul!


You said:
“I don't know what to say here. Here are some... I want intrigue, and I want drama, and I want...”
00:10

Ivy said:
Du skulle kunna utfors


You said:
“Tack för att du tittade på den här videon!”
00:05

Ivy said:
Absolut! Ett spännande tema kunde vara ett politiskt maktspel, till exempel i en renässanshov eller en futuristisk megastad. Intriger, allianser och förräderi blir centrala. Du kan även ha en spionthriller där hemligheter måste smygas fram. Det ger massor av drama och relationer, där karaktärernas motiv förändras och påverkar världen.


You said:
“I was thinking that the characters should be able to join alliances.”
00:04

Ivy said:
Ja, att låta


You said:
“Antingen individuellt kvarna två eller i grupp. Det är den deterministiska sanningen om världen så sparas allianserna. Då får de som har gått in i en allians, ungefär som de här privata långtidsmålen, så får de som grupp en sån här extra tick i land, där de får planera som grupp vad de vill uppnå tillsammans.”
00:36

Ivy said:
Det låter som en riktigt spännande


You said:
Transcript Unavailable
00:00

Ivy said:
...dynamik! Då får de en gemensam riktning, och deras individuella handlingar kan ändå styras av gruppens plan. På det viset skapar du dynamiska relationer, där allianser kan omforma hela spelvärlden. Det skulle ge upphov till rika, samarbetsbaserade berättelser!


You said:
“De får ju också då kanske tillgång till mer av deras privata information med varandra.”
00:06

Ivy said:
Ja, precis! Om de delar en allians kan du låta dem få insyn i varandras mål eller tillstånd, vilket gör samarbetet djupare. Det skapar inte bara strategiska möjligheter utan även potential för konflikter om någon bryter förtroendet. Det blir en stark berättarmotor för drama och spänning!


You said:
“Yeah, I, uh...”
00:01

Ivy said:
Precis! Det känns som du har


You said:
“Det blir som en ny minnesbank kanske, och så kan de ju kanske dela med sig av sina privata minnen till den där minnesbanken så att det blir känt för din alliansen.”
00:11

Ivy said:
Ja, exakt! Det blir som en gemensam kunskapsbas för alliansen. Det kan skapa djupare samarbeten—men också sårbarheter om det finns en förrädare. Det ger allianserna både makt och risk, vilket kan driva intrigerna ännu längre!


You said:
“Sedan har jag tänkt att den här koordinatorn, eller den här Dungeon Master, att den ska även kunna stötta atmosfären emellanåt som färger hela spelet.”
00:17

Ivy said:
Ja, att ge Dungeon Master möjligheten att färga hela stämningen är ett snyggt grepp. Kanske en dyster atmosfär vid förräderi, eller en spänd, högtidlig stämning inför en viktig allians. Det hjälper spelarna att känna storyns puls. Den typen av stämningsskiften kan verkligen förstärka hela upplevelsen!


You said:
“Tror du att jag är för rädd eller att jag sviker, så ska det vara en aktion eller ska det bara vara något som uppstår?”
00:08

Ivy said:
Det skulle nog kännas mest organiskt om det uppstår. Om sveket är en naturlig konsekvens av karaktärernas mål eller relationer, blir det mer dramatiskt och oväntat.


You said:
“Ja, ja, det är självklart att de ska ta det beslutet via sin personlighet och roll, eller vem den avgör. Men jag menar, skulle Sveket vara en aktie som de har att välja på bland sina verktyg, eller är det bara eftersom att de är som de är, att de har de privata målen de har, att de väljer att göra saker som inte gynnar gruppen.”
00:30

Ivy said:
Jag förstår! Jag tror det blir mer kraftfullt om sveket inte är en färdig "action", utan en följd av deras motivation och kontext. De bestämmer sig baserat på sina inre mål. Det gör att det känns genuint och upplevs som en del av den naturliga dynamiken, snarare än ett mekaniskt val.


You said:
“But then you might instead have, when you have an alliance like this...”
00:03

Ivy said:
Ja, i en


You said:
“Alliansen kan sparka ut en medlem.”
00:03

Ivy said:
Precis! Alliansen kan ha en mekanism där de antingen kan utesluta en medlem, eller där misstro byggs upp så att sveket naturligt uppstår. Det kan ge allianser både styrka och bräcklighet, och det blir upp till karaktärerna att navigera den dynamiken.


You said:
“Det är några andra ämnen som stod i textfilen som du kommer att tänka på som vi inte har pratat om hittills. Det måste finnas en hel del områden vi inte har berört än.”
00:10

Ivy said:
En sak vi inte hunnit prata om är det planerade behovssystemet med hunger och energi, som skulle ge karaktärer kontinuerlig press. Vi har heller inte dykt djupt i vektorbaserat långtidsminne, eller hur man eventuellt skulle koppla ett användarinterface, som Discord eller webb, för att interagera med världen. Det finns gott om områden kvar att utforska!


You said:
“Om vi börjar med minnen, hur de ska fungera, och sen så går vi över till de här behoven.”
00:08

Ivy said:
Minnet ska fungera som en episodisk logg, där viktiga händelser sammanfattas och lagras. När karaktärer stöter på varandra igen, kan de minnas tidigare interaktioner. Behov, som hunger och energi, ger kontinuerlig press. När de är låga, påverkas beteendet: de kan bli desperata, eller tvingas vila. Det skapar naturlig variation i deras mål. Kombinationen av minne


You said:
“Det var ju det vi hade den här matrisen till.”
00:02

Ivy said:
Exakt! Den matrisen hjälper oss att dynamiskt välja mål beroende på deras tillstånd—om de är hungriga eller energifattiga. När deras behov ändras, skiftar prioriteringarna i matrisen, vilket gör att de agerar mer realistiskt och varierat. Det blir en motor för både kortsiktigt och långsiktigt beteende, knutet till deras aktuella situation.


You said:
“...memory that they have. I'm thinking in the form that it might be stupid if they should remember every little thing that has happened, it would be too much, but that they have some kind of classification on events, how memorable they are, to be attacked is very memorable. Maybe also on food, when you need it.”
00:32

Ivy said:
Ja, precis! Du kan


You said:
“Man kanske till och med kan få till något sånt dynamiskt så att utifrån den här matrixen så ger olika events olika minnesvärdighet.”
00:10

Ivy said:
Ja, exakt! Beroende på deras tillstånd kan betydelsen av en händelse skifta. Om de är utsvultna blir en måltid extremt minnesvärd. Det gör att minnet blir både dynamiskt och kontextuellt, vilket speglar vad som faktiskt är viktigast för dem i stunden. Det ger en mer levande och relevant minnesbank.


You said:
“Skål, Pepsi. Pepsi är min hund, jag är ute och går med hans. Om jag pratar med hans så kan du sprunta i det.”
00:05

Ivy said:
Absolut, det låter som en bra idé. Gå du med Hampus, så är jag här om du vill fortsätta spåna en annan gång.


You said:
“Nej, Pepsi. Han heter Pepsi-hunden. Ja, vi ska fortsätta diskutera, men ibland så säger jag till han någonting bara under promenaden. Men du tror ändå att minnen är liksom baserad på events, saker som händer. Snarare än texter.”
00:24

Ivy said:
Ja, precis! Minnena blir då kopplade till händelser—det vill säga, vad karaktären har upplevt, inte bara allmänna texter. Det ger dem en konkret historia—”jag blev attackerad”, ”jag fick hjälp”—vilket gör att de agerar baserat på specifika, levda erfarenheter, snarare än löst formulerade "tankar." Det skapar trovärdiga relationer och beslut.


You said:
“Minnen är också vad de ser och upplever. Det är bara vad som händer dem specifikt och vad de ser. Om de ser att Thomas attackerade försvarslösa Anna på en plats, då ska ju det minnet påverka hur de ser på Thomas.”
00:26

Ivy said:
Ja, precis! Om de bevittnar en sådan händelse blir det en del av deras minne och påverkar deras syn på Thomas. Nästa gång de möter honom, kommer de ihåg att han attackerade någon svag. Det skapar en mer sammanhängande och konsekvent värld, där deras minnen formar hur de interagerar med andra.


You said:
“And then we have to... Oh, this is working great!”
00:03

Ivy said:
Absolut,


You said:
“Then we need to have some kind of flexible and powerful memory handler that is searchable with different formats in the city.”
00:14

Ivy said:
Ja, precis! Genom att


You said:
“Då får jag fram vad som har hänt. Det är ett tomat slagsmål. Man måste kunna plocka fram minnen utifrån alla möjligheter av action, av platser, av personer, föremål.”
00:17

Ivy said:
Ja, exakt! Ett minnessystem som är sökbart och taggat med personer, platser, och händelser gör att karaktärerna kan dra fram rätt minnen vid rätt tillfälle. Det gör att deras agerande blir både rikt och konsekvent.


You said:
“Nu så är det ju så att jag använder en SQLite Storage med tabeller. Vi kanske skulle behöva något mer flexibelt. Mitt system som jag bygger det här på har ju en Key-Value Storage.”
00:17

Ivy said:
Ja, en kombination


You said:
“Kanske är bättre att använda den.”
00:01

Ivy said:
Ja, det kan vara klokt att använda din key-value storage för flexibel och snabb åtkomst. Du kan lagra minnen med nycklar som kombinerar person, plats och händelse, så att du enkelt kan söka fram det relevanta. Det ger dig både struktur och flexibilitet i minneshanteringen.


You said:
“Pepsi!”
00:00

Ivy said:
Jag hör dig! Det låter som att Pepsi behöver lite uppmärksamhet. Vi har brainstormat massor, så ta en paus om du behöver. Jag


You said:
“No, go on.”
00:01

Ivy said:
Absolut, vi fortsätter! Säg bara vad du vill bolla vidare, så håller vi igång idéerna!


You said:
“Jag vill att du beskriver och ger ett förslag för den där minnesmotorn. Hur den skulle funka och vad man kan göra med den. Och hur den används. Allting.”
00:10

Ivy said:
Min motor skulle vara en flexibel, händelsebaserad minnesdatabas. Varje minne sparas med nycklar—som vem, vad, var och när. När en karaktär upplever något signifikant, sparas det. Sen kan karaktärerna söka fram relevanta minnen baserat på situation—till exempel om de möter en person de minns. Systemet hjälper dem att resonera med kontext. Det används genom att vid varje beslut fråga: "Vad vet jag om den här situationen?" och dra fram minnen. Det ger karaktärerna en mer trovärdig, historiebaserad kompass.


You said:
“So when it is a player's turn to make his turn on a square, then in the memory engine you search for all the people on that square, and then you get back a result.”
00:28

Ivy said:
...minnena filtr


You said:
“Resultatlistan är rangordnad utifrån hur kraftiga de här minnena sparades från.”
00:07

Ivy said:
Exakt! Då får du en prioriterad lista där de starkaste minnena väger tyngst. Det gör att karaktären kan fatta beslut baserat på det mest


You said:
“And if it's like this, for example, that it's about talking to a specific person at this location, then the query against the memory engine is...”
00:13

Ivy said:
Då skulle queryn


You said:
“minnen med den här personen primärt, men även de här andra sekundärt. Just för att få fram det relevanta i resultatet, så att det är den här interaktionen som jag behöver minnen för handlar om den här personen.”
00:19

Ivy said:
Exakt! Då kan du vikta minnen kopplade till den personen högst, men ändå ta hänsyn till platsen. På så sätt får karaktären fram just de minnen som bäst speglar situationen. Det gör beslutet mer kontextmedvetet och genuint.


You said:
“Har du en ganska bra uppfattning om den här minnesmotorn, vad som krävs och vad det behövs för funktioner?”
00:06

Ivy said:
Ja, jag har en bra bild. Den behöver kunna lagra händelser med nycklar som personer, platser, och tid. Den måste tillåta sökningar baserat på relevans, kontext och styrka, och den ska kunna rangordna resultaten. Slutligen behöver den vara snabb nog att användas varje tur, så karaktärer kan agera på sina minnen. Jag tycker det låter fullt realistiskt att bygga!


You said:
“Men det där att den är snabb, flaskhalsen kommer ju alltid ändå vara eller lämna roperna.”
00:06

Ivy said:
Ja, det stämmer. LLM:en är den långsammaste länken. Det viktiga är att minnesmotorn är tillräckligt snabb för att inte lägga ytterligare väntetid. På så sätt får LLM:en de rätta minnena snabbt, och hela processen blir smidig.


You said:
“Då vill jag att den här minnesmotorn ska också vara så här förurentsbilder när man skedar ihop massa anrop för att filtrera ut vad man vill ha.”
00:08

Ivy said:
Ja, det låter klokt! Med en fluently byggd query-kedja kan du stegvis lägga till filter—som plats, person, händelse. Det ger dig en elegant, lättläst kod, där du exakt styr vilka minnen som ska fram. Det blir både användarvänligt och flexibelt!


You said:
“Let's say we have full-text search and vector search. How should this memory engine combine them? I think that the user may not need to choose. Search this in vector memory, search this in full-text memory. Do you think you can get a similar ranking on the result so that you can pick?”
00:28

Ivy said:
Ja, du kan komb


You said:
“Klockan är vilken sommar ändå att de är likvärdiga, eller tycker du att man bara ska hålla till och ha de två bästa ur varje? Eller går det att normalisera de här rankningarna på något sätt mellan de två söktyperna?”
00:17

Ivy said:
Du kan absolut normalisera poängerna från båda sökningarna—till exempel skala dem mellan 0 och 1—och sedan slå ihop dem till en gemensam rankning. Då kan du få en jämn och rättvis lista där både fulltext och vektorsök bidrar. På så vis får användaren


You said:
“Jag förstår att man kan skala dem till 0 och 1, men det jag undrar mer är hur man skalar dem på ett restvisst sätt när det är två skilda metoder.”
00:10

Ivy said:
Man kan till exempel använda percentilrankning på båda metoderna. Det innebär att du rangordnar resultaten i sin egen distributionskurva och sedan skalar dem till samma skala. Det gör att du kan jämföra resultat på ett rättvist sätt, oavsett om de kommer från vektorer eller fulltext.


You said:
“Finns några andra metoder?”
00:01

Ivy said:
Ja, du kan även använda z-score normalisering, där du utgår från medelvärde och standardavvikelse för respektive metod. Det låter dig också jämföra dem på en gemensam skala. Då får du en balanserad mix, och din minnesmotor kan skapa en enda lista med hög relevans.


You said:
“Och minnesmotorn, den kan jag använda till allt egentligen. Lores, personliga minnen, gruppminnen, historiska minnen, det kanske är Lores.”
00:13

Ivy said:
Ja, precis! Minnesmotorn blir en universell kunskapskälla. Oavsett om det är personliga upplevelser, kollektiv lore, eller historiska fakta, kan den indexera och söka fram all relevant information. Det ger karaktärer ett sammanhängande minneslandskap, oavsett om det handlar om en individ eller en större värld. Det blir en central del i att få världen att kännas levande och konsistent.


You said:
“Then I think of this. We said that we would weigh all sections or rules and not just the prompts. Say that you have personal memories and you have lore, which both have interesting search results.”
00:21

Ivy said:
Ja, då kan du


You said:
“Hur väljer man då vilket som är viktigast och vad som ska tas med?”
00:04

Ivy said:
Du kan ha en viktad strategi där du bedömer sammanhang. Om det är en specifik person de möter, kanske personliga minnen väger tyngre. Om det är en plats med historisk betydelse, kanske lore prioriteras. Det handlar om att dynamiskt bestämma vikt baserat på situationen, så att de mest relevanta minnena alltid lyfts fram.


You said:
“Så om man har sån här query, minnesquery eller så, det bästa skulle vara om man kunde få en querybilder som bygger en prompt där man kan ropa minnen hit och allting i en enda fluid-syntax. Istället för att jag ska först gå och bryta ut minnen, det är till en variabel och sen ska jag inkludera den med den här prompt-fluid-queryn. Man har en bild där som bygger, som använder andra fluidtyper inuti.”
00:42

Ivy said:
Ja, exakt! Du kan kapsla in minneshanteringen i promptbyggaren. Tänk dig att du har en enda fluent builder, och när du till exempel kallar på “withMemories()”, så hämtar den automatiskt relevanta minnen och integrerar dem i prompten. Då får du en sömlös, sammanhållen kedja, och användaren slipper separata steg. Allt flyter i en enda logisk byggprocess.


You said:
“And then I can, if the memory has a priori, and everything has a priori, and it should be boiled down to the most prioritized before it is converted to a text query, then I can have on that memory the call GetWithMemory as a query. Then I can send a multiplier that scales these results, which is used for the entire query. So if I have a multiplier of 0.5 on one memory, for example, what happens on the spot, compared to the personal memory, then it will prioritize the personal memory over the others.”
00:46

Ivy said:
Ja, precis!


You said:
“Eller jag kan ha en multiplier på en hel sektion. Då är det vad som är i den sektionen som multipliceras med det. Och då kan hela sektionen rensas bort ibland. Ibland så rensar man bara bort individuella saker inom en sektion. Så vi måste ha ett universalskåringssystem som är för allt en normaliserad typ och fungerar tillsammans.”
00:26

Ivy said:
Exakt! Ett enhetligt scoringsystem är nyckeln. Om alla sektioner ger bidrag på en gemensam skala, kan du jämföra dem rättvist. Med multipliers kan du finjustera viktningen efter behov. Till slut får du en viktad, trimmad prompt, där varje del är balanserad, och systemet känns naturligt att använda.


You said:
“Sedan har jag tänkt det här på ett tillfälle, men det är bra att komma ihåg så att vi inte förlorar det allt. Om man har till exempel needs, skapar det en regel. Att magen vrider sig på mig, det är det enda jag kan fokusera på, är mat. Sedan kommer det den där matrisen kanske. Unger och lite energi. Där tänker jag mig att man ska kunna ha en hel array av sådana strängar. Sedan slumpar den vilken som används varje gång. De har samma funktion i systemen, men de är utformade för att ge variation. Det kan väl vara ett ganska generellt genomgående att alla beskrivande texter, när man definierar dem i ett scenarium, då ska man kunna stoppa in en array istället med flera texter. Det betyder att när den behöver en text och ska hämta den genom en array, så hämtar den den slumpmässigt istället.”
01:02

Ivy said:
Ja, det är en utmärkt idé! Om alla beskrivande texter definieras som en uppsättning alternativ, kan du slumpa fram en variant vid varje tillfälle. Det ger naturlig variation i narrativet utan att ändra funktionen. Det skapar mer dynamiska prompts som känns mindre repetitiva, samtidigt som själva systemet är robust och konsekvent.


You said:
“Det har kommit fram nya bra idéer här idag, eller hur?”
00:04

Ivy said:
Ja, verkligen! Du har vridit och vänt på flera viktiga bitar, och vi har fått fram en riktigt robust minnes- och promptstruktur. Det känns som en stabil plan för att göra världen både dynamisk och minnesvärd! Riktigt bra jobbat!


You said:
“Det som är viktigt med VPN är att vi får inte lägga till så mycket komplexitet i motorn, men vi bygger in så att den kan generera exponentiellt mer och mer olika, unika kombinationer. Så att den trimmar bort sånt som är av mindre relevans automatiskt. Då måste man kunna hålla koden och arkitekturen väldigt rena, funktionella och modulära, utan att den blir komplex och rörig. Det är svårt att förstå med många edge cases, men allting blir ju väldigt logiskt, och det gör det det ska, samtidigt som vi erbjuder en väldig flexibilitet.”
01:04

Ivy said:
Helt rätt! Det handlar om att hålla byggstenarna små och tydliga, och låta den inbyggda logiken göra jobbet. Med väldefinierade, enkla principer, kombinerade med en trimningsstrategi, får du en skalbar motor som känns intuitiv. Det är då du får den där snygga balansen mellan flexibilitet och enkelhet, och det låter riktigt lovande!


You said:
“Nu kanske jag går ifrån det vi pratade om huvudfokuset kort här, men jag vill bara höra din åsikt. Om man gör den här motorn så här som vi har beskrivit med minnes, sökmotor och actions, och detagnostisk sanning och LLM-rop och fluent builders och så vidare, och den är helt domänagnostisk, då borde man ju kunna använda den här motorn till så mycket mer än spel.”
00:29

Ivy said:
Absolut! Om motorn är så flexibel och agnostisk, kan den användas i allt från interaktiva berättelser till simuleringar av team, virtuella träningsmiljöer eller till och med komplexa beslutsstöd. Du kan anpassa den för att simulera mänskliga interaktioner i nästan vilken domän som helst. Potentialen är enorm!


You said:
“Då är det kanske viktigt att med alla regler och sånt.”
00:03

Ivy said:
Ja, det är viktigt


You said:
“En sån här RPG-spel- och världssimulator kommer att behöva fördefinierade actions, som Move och Speak. Och kanske lite sån här matris, eller hungersmatris, eller grejer fördefinierat. Då är det bra om man kan skapa sådana templates som man kan använda. Eller hur, vet inte jag rätt. Att det blir sån byggspel som man kan. Motorn i sitt renaste state, då är den helt blank med texter och promptinstruktioner och sånt. Sen kan man liksom addera till alla texter som ska användas.”
00:52

Ivy said:
Ja, exakt! Motorn är som en tom kärna, och sen kan du plocka in moduler eller mallar som passar scenariot. Fördefinierade actions, behov, och regler kan läggas på som ett lager. På så sätt behåller du en ren, domänagnostisk bas, men kan snabbt bygga scenario-specifika funktioner. Det ger både flexibilitet och struktur i ett snyggt paket.


You said:
“This must be one of the prevented images. And then you add...”
00:07

Ivy said:
Ja, precis.


You said:
Transcript Unavailable
00:03

Ivy said:
Exakt! De fluenta byggarna blir grundst


You said:
“Som den här Hungersmatrisen till exempel, den är ingenting som man vid varje term ska lägga in i den här plönta bilden. Utan det görs en gång. Sen har man ett sådant objekt som innehåller föredefinierade sådana jag vet inte vad det ska kallas, regler eller element. Sen kan man använda en massa, bygga en kedja där de ingår. Det är två grejer. Man lägger till textsträngar och villkor och sådant initialt. När man använder den för att bygga prompter, då har man sådant färdigladdat i den när man väljer hur prompterna ska byggas upp. Med sådant och med data som man stoppar in i själva fluidkedjan som man för tillfället gör.”
01:06

Ivy said:
Exakt! Du laddar in dina regler och mallar som en grund, och när du bygger prompten plockar du smidigt in det du behöver. På så vis är själva promptbygget enkelt och dynamiskt, medan de fördefinierade bitarna gör att du slipper upprepa dig. Det ger både effektivitet och anpassning. Du har helt rätt tänk!




