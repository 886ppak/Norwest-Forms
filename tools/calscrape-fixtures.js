// Anonymised from the three real mobilisation emails. "Aiden Amur" is the test worker.
module.exports = {
// PSA table, layout text (columns separated by 2+ spaces)
psa: `Please see below mobilisation information.

VD    SITE    Class    Full Name    RH Card No.    Shift    Mobe    First Shift    Travel In    Last Shift    SD/FD    Demob    Travel Out
30234     PSA         DS Supervisor           Person One      RH100001      DS1     17/07/2026     17/07/2026                 ALREADY ON SITE              20/07/2026                          20/07/2026   FLY QF2757 GBW/PER 1
30234     PSA    CO Operator - 220T CRWL        Aiden Amur      RH118877      DS2     29/07/2026     29/07/2026       ALREADY ON SITE FROM FRANNA WORKS      3/08/2026    FD REQUIRED 30/07/26   4/08/2026           DRIVE SITE TO ZN
30234     PSA    CO Operator - 300T          Person Two      RH160836      DS2     28/07/2026     29/07/2026      ALREADY ON-SITE TRANSFER FROM CRAWLER   29/07/2026                          30/07/2026          DRIVE SITE TO ZN

Kind Regards,`,
// BHP table, layout text, no VD or site column, DIDO commute, blank SD/FD
bhp: `Class                  Full Name          Shift   Commute       Mobe      First Shift        Travel In        Last Shift   SD/FD     Demob            Travel Out          Accommodation
CO Operator - 650T      Aiden Amur        DS       DIDO     23/07/2026   23/07/2026    DRIVE ZNE TO SITE     25/07/2026           26/07/2026   DRIVE 650-2 SITE TO PHE       TBA
Rigger        Person Three    DS       DIDO     23/07/2026   23/07/2026    DRIVE AUSKI TO SITE   25/07/2026           26/07/2026     DRIVE SITE TO PHE            TBA`,
// FMG table pasted as one cell per line (as copied from the mail), blank SD/FD omitted
fmgLines: `VD JOB#
SITE
Class
Full Name
Shift
Mobe
First Shift
Travel In
Last Shift
SD/FD
Demob
Travel Out
Accommodation
30564
FMG Rail line 157KM
CN Operator - 25T
Aiden Amur
DS
2/09/2026
2/09/2026
DRIVE
2/09/2026
2/09/2026
DRIVE
N/A
30564
FMG Rail line 157KM
Rigger
Person Four
DS
2/09/2026
2/09/2026
DRIVE
2/09/2026
2/09/2026
DRIVE
N/A
Please advise if you have any issues`,
// Five dates: the 4th is a stand-down date in the SD/FD column (William-style row)
fiveDates: `30234     PSA    CO Operator - 300T       Aiden Amur      RH160836      DS      16/07/2026     18/07/2026                 DRIVE ZNE TO SITE            28/07/2026     17/07/2026     28/07/2026   STAY ON SITE - TRANSFER`,
// Supervisor contact list: name appears, but no job row
contact: `Name  Role  Shift  Number  IN  OUT
Aiden Amur       Coordinator      DS     0401 227 796    13/07/2026    20/07/2026
Sean Noyes       Coordinator      DS     0457 888 850    20/07/2026    2/08/2026`,
};
